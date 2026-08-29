import 'reflect-metadata';
import {restrictRoutes} from '../src/middleware/middleware';
import {configureKit, resetKitConfig} from '../src/config';
import {isUnderPrefix, RouteRegistry} from '../src/decorators/routeDecorator';

/**
 * `restrictRoutes` is the only thing standing between a client and Parse's
 * generic REST API, so what it lets through is a security boundary and worth
 * pinning precisely.
 *
 * The auth endpoints are the interesting part. They are blocked by default —
 * the documented approach is to expose the ones you want as cloud functions —
 * and that is far and away the most surprising thing this middleware does. A
 * caller gets a bare 403 and no clue why `Parse.User.logIn()` stopped working.
 * These tests pin both halves: that the block holds, and that the response
 * explains itself.
 */

type Ran = {nexted: boolean; status?: number; body?: any};

function run(
  path: string,
  method = 'GET',
  headers: Record<string, string> = {}
): Ran {
  const result: Ran = {nexted: false};

  const req: any = {path, method, headers};
  const res: any = {
    status(code: number) {
      result.status = code;
      return res;
    },
    json(body: any) {
      result.body = body;
      return res;
    },
  };

  restrictRoutes(req, res, () => {
    result.nexted = true;
  });

  return result;
}

describe('restrictRoutes', () => {
  afterEach(() => {
    resetKitConfig();
  });

  describe('the routes it always allows', () => {
    it.each(['/health', '/serverInfo', '/files/photo.png'])(
      'lets %s through',
      path => {
        expect(run(path).nexted).toBe(true);
      }
    );

    it('lets /functions through, which is what validateEntityRoutes rewrites to', () => {
      expect(run('/functions/createNote', 'POST').nexted).toBe(true);
    });

    it('lets a registered @Route prefix through', () => {
      // The registry is what `@Route(Note)` populates; stub the lookup rather
      // than standing up a decorated class for a middleware test.
      const spy = jest
        .spyOn(RouteRegistry, 'isRegisteredPrefix')
        .mockReturnValue(true);

      expect(run('/notes/listNotes').nexted).toBe(true);
      spy.mockRestore();
    });
  });

  describe('the routes it always blocks', () => {
    it.each(['/classes/Note', '/schemas/Note', '/batch', '/aggregate/Note'])(
      'blocks %s',
      path => {
        const {nexted, status} = run(path);
        expect(nexted).toBe(false);
        expect(status).toBe(403);
      }
    );

    it('explains what is allowed instead of only saying no', () => {
      const {body} = run('/classes/Note');
      // Unchanged, so anything already matching on it keeps working.
      expect(body.message).toBe('Route not allowed');
      expect(body.detail).toContain('/classes');
      expect(body.detail).toContain('/functions');
    });
  });

  describe('auth endpoints, blocked by default', () => {
    it.each([
      ['/login', 'POST'],
      ['/login', 'GET'],
      ['/logout', 'POST'],
      ['/users', 'POST'],
      ['/requestPasswordReset', 'POST'],
      ['/verificationEmailRequest', 'POST'],
    ])('blocks %s %s', (path, method) => {
      const {nexted, status} = run(path, method);
      expect(nexted).toBe(false);
      expect(status).toBe(403);
    });

    it('names allowAuthRoutes in the 403, so the fix is discoverable', () => {
      const {body} = run('/login', 'POST');
      expect(body.detail).toContain('allowAuthRoutes');
      expect(body.detail).toContain('cloud function');
    });
  });

  describe('auth endpoints, with allowAuthRoutes on', () => {
    beforeEach(() => {
      configureKit({allowAuthRoutes: true});
    });

    it.each([
      ['/login', 'POST'],
      ['/login', 'GET'],
      ['/logout', 'POST'],
      ['/users', 'POST'],
      ['/users/me', 'GET'],
      ['/sessions/me', 'GET'],
      ['/requestPasswordReset', 'POST'],
      ['/verificationEmailRequest', 'POST'],
    ])('allows %s %s', (path, method) => {
      expect(run(path, method).nexted).toBe(true);
    });

    it('still blocks GET /users, which would query the whole user table', () => {
      const {nexted, status} = run('/users', 'GET');
      expect(nexted).toBe(false);
      expect(status).toBe(403);
    });

    it('still blocks PUT /users/<id>', () => {
      expect(run('/users/abc123', 'PUT').nexted).toBe(false);
    });

    it('does not open anything else', () => {
      expect(run('/classes/Note').nexted).toBe(false);
      expect(run('/schemas/Note').nexted).toBe(false);
    });

    it('matches the path exactly, so a lookalike prefix stays blocked', () => {
      expect(run('/loginAsAnyone', 'POST').nexted).toBe(false);
      expect(run('/users/abc/login', 'POST').nexted).toBe(false);
    });
  });

  describe('prefix matching, by whole segments', () => {
    /*
     * A bare `startsWith` matches characters, not path segments, so every
     * allowlist entry here silently covered a family of lookalikes. The
     * dangerous one is a registered @Route prefix: `@Route('user')` yields
     * `/user`, and character matching would open every path beginning `/user`
     * — Parse's own `/users` table endpoints included, which this library
     * documents as blocked.
     */

    it('allows the system route itself and what is under it', () => {
      expect(run('/health').nexted).toBe(true);
      expect(run('/files/photo.png').nexted).toBe(true);
    });

    it('does not treat a lookalike system route as allowed', () => {
      expect(run('/healthz-internal').nexted).toBe(false);
      expect(run('/serverInfoDump').nexted).toBe(false);
      expect(run('/filesystem/etc/passwd').nexted).toBe(false);
    });

    it('does not treat a lookalike function route as allowed', () => {
      expect(run('/functionsX', 'POST').nexted).toBe(false);
    });

    it('keeps a prefix from opening a longer sibling path', () => {
      // `isRegisteredPrefix` is this predicate over the registry, and the
      // registry only gains a prefix once a matching @CloudFunction exists —
      // so the rule itself is what is worth pinning. `/user` must not admit
      // `/users`, which is Parse's user table.
      expect(isUnderPrefix('/user', '/user')).toBe(true);
      expect(isUnderPrefix('/user/getUser', '/user')).toBe(true);
      expect(isUnderPrefix('/users', '/user')).toBe(false);
      expect(isUnderPrefix('/users/abc123', '/user')).toBe(false);
    });
  });

  describe('master key bypass', () => {
    it('lets a valid master key past everything', () => {
      configureKit({masterKey: 'sekrit'});
      expect(
        run('/classes/Note', 'GET', {'x-parse-master-key': 'sekrit'}).nexted
      ).toBe(true);
    });

    it('does not bypass on a wrong key', () => {
      configureKit({masterKey: 'sekrit'});
      expect(
        run('/classes/Note', 'GET', {'x-parse-master-key': 'wrong'}).nexted
      ).toBe(false);
    });

    it('fails closed when no master key is configured at all', () => {
      // An unset key must never match, or an empty header would admit everyone.
      expect(run('/classes/Note', 'GET', {'x-parse-master-key': ''}).nexted).toBe(
        false
      );
    });
  });
});
