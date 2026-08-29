import {start, stop, api, MOUNT} from './harness';
import './functions';

/**
 * Which endpoint protections are actually ENFORCED, as opposed to declared.
 *
 * Every check here was written to answer a specific doubt raised in review,
 * against a running server rather than by reading the source. Whichever way
 * they come out, they belong in the suite: a protection that is only
 * documentation is precisely the silent-failure class this library exists to
 * remove.
 */

beforeAll(async () => {
  await start();
}, 180000);

afterAll(async () => {
  await stop();
});

describe('the top-level requiresAuth flag', () => {
  it('gates an anonymous caller', async () => {
    // `requiresAuth: true` and nothing else. If the body runs, the flag is
    // decorative — and it is one character from `requireUser`, which works.
    const res = await api(`${MOUNT}/smoke-widgets/requiresAuthOnlyWidget`, {
      method: 'POST',
      body: {},
    });

    expect(res.body?.reached).toBeUndefined();
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('protections when /functions is called directly', () => {
  /*
   * `restrictRoutes` allows `/functions/*` because that is what
   * `validateEntityRoutes` rewrites entity routes into. The question is what a
   * client skips by going there itself: the method check and the rate limiter
   * both live in validateEntityRoutes, which returns early for any path that is
   * not a registered entity prefix.
   */

  it('enforces the declared method on the entity route, and not on /functions', async () => {
    // `methods` describes the REST facade, so a POST at a GET-only entity
    // route is 405...
    const viaEntity = await api(`${MOUNT}/smoke-widgets/limitedSmokeWidget`, {
      method: 'POST',
      body: {},
    });
    expect(viaEntity.status).toBe(405);

    // ...but /functions is Parse's protocol endpoint, where POST is always
    // correct. See the Cloud.run test below for why this must stay open.
    const direct = await api(`${MOUNT}/functions/limitedSmokeWidget`, {
      method: 'POST',
      body: {},
    });
    expect(direct.status).toBe(200);
  });

  it('still enforces the rate limit', async () => {
    // A POST endpoint, so the method check passes and the limiter is what is
    // actually under test. max: 2 per minute — six attempts must not all pass.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await api(`${MOUNT}/functions/limitedPostWidget`, {
        method: 'POST',
        body: {},
      });
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
    // And the first couple genuinely got through, so this is a limit rather
    // than a blanket refusal.
    expect(statuses.filter(s => s === 200).length).toBeGreaterThan(0);
  });

  it('does not break Parse.Cloud.run against a GET-declared function', async () => {
    /*
     * `Parse.Cloud.run` — every official Parse SDK — POSTs to
     * /functions/{name}. Always. POST is the protocol there.
     *
     * `methods` describes the REST facade this library puts in FRONT of that
     * (`GET /api/widgets/listWidgets`). Enforcing it on /functions as well
     * would make any GET-declared function unreachable from `Cloud.run`, which
     * the generated template's own `listNotes` would hit immediately.
     *
     * So the method check must stay on the entity route, and only the rate
     * limit follows to /functions.
     */
    // No master key — a master-key call bypasses restrictRoutes entirely and
    // would dodge the very thing under test. This is what an ordinary client
    // sends.
    const res = await api(`${MOUNT}/functions/limitedSmokeWidget`, {
      method: 'POST',
      body: {},
    });

    expect(res.status).toBe(200);
  });

  it('lets the master key through a requireRoles gate, as requiresAuth does', async () => {
    /*
     * The two gates have to agree about the same caller, or the same request
     * passes one and fails the other — which is what happened: `requiresAuth`
     * exempted the master key while `requireRoles` answered
     * `Authentication required`, code 101, to the most privileged principal
     * there is.
     *
     * Letting it through concedes nothing. A caller holding the master key is
     * already past restrictRoutes, already bypasses every CLP and ACL, and
     * could grant itself the role and call again. The old refusal only broke
     * cron jobs and migrations.
     */
    const roleGated = await api(`${MOUNT}/functions/gatedSmokeWidget`, {
      method: 'POST',
      body: {},
      master: true,
    });
    expect(roleGated.status).toBe(200);
    expect(roleGated.body?.reached).toBe(true);

    const authGated = await api(`${MOUNT}/functions/requiresAuthOnlyWidget`, {
      method: 'POST',
      body: {},
      master: true,
    });
    expect(authGated.status).toBe(200);
    expect(authGated.body?.reached).toBe(true);
  });

  it('still enforces requireRoles', async () => {
    // Role checks live in the handler wrapper, so they should survive a direct
    // call. This is the control: if it fails, the finding is broader.
    const res = await api(`${MOUNT}/functions/gatedSmokeWidget`, {
      method: 'POST',
      body: {},
    });
    expect(res.body?.reached).toBeUndefined();
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
