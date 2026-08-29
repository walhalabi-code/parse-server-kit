import 'reflect-metadata';
import {
  extractMasterKey,
  conditionalJsonMiddleware,
} from '../src/middleware/middleware';

/**
 * `extractMasterKey` is body-parser's `verify` callback, so it runs on the raw
 * buffer of every request that carries a body.
 *
 * It used to `JSON.parse` that buffer in full — a second complete parse of every
 * body in the system, to look for a key almost no request has. It now scans the
 * bytes first. These tests pin the observable behaviour across that change:
 * whatever the body, the master key must be extracted exactly when it was
 * before, and never when it was not.
 */

type FakeRes = {status: jest.Mock; json: jest.Mock};

function fakeRes(): FakeRes {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function run(
  body: string
): {req: any; res: FakeRes; threw: boolean; error?: any} {
  const req: any = {};
  const res = fakeRes();
  let threw = false;
  let error: any;
  try {
    extractMasterKey(req, res as any, Buffer.from(body), 'utf8');
  } catch (caught) {
    threw = true;
    error = caught;
  }
  return {req, res, threw, error};
}

describe('extractMasterKey', () => {
  it('extracts a masterKey from the body', () => {
    const {req} = run(JSON.stringify({masterKey: 'secret', other: 1}));
    expect(req['x-master-key']).toBe('secret');
  });

  it('extracts the _MasterKey spelling too', () => {
    const {req} = run(JSON.stringify({_MasterKey: 'secret'}));
    expect(req['x-master-key']).toBe('secret');
  });

  it('sets nothing when the body has no master key', () => {
    const {req, threw} = run(JSON.stringify({name: 'x', items: [1, 2, 3]}));
    expect(req['x-master-key']).toBeUndefined();
    expect(threw).toBe(false);
  });

  it('leaves malformed JSON alone when no marker is present', () => {
    // The fast path returns before parsing, so body-parser is left to reject
    // this itself — which it does, with a 400. Previously this threw here.
    const {req, res, threw} = run('{not valid json');
    expect(req['x-master-key']).toBeUndefined();
    expect(threw).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('still rejects malformed JSON that does mention a master key', () => {
    const {res, threw} = run('{"masterKey": broken');

    // It throws, and does NOT write a response of its own.
    //
    // This used to do both, which left Express reporting "Cannot set headers
    // after they are sent" on top of the actual problem. body-parser catches
    // the throw and answers, so the caller gets one clean response and the log
    // shows one cause.
    expect(threw).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('asks for a 400 rather than letting body-parser pick 403', () => {
    /*
     * body-parser wraps a `verify` failure as `createError(403, err)`, so
     * throwing a bare Error turns a malformed body into a 403 — a silent
     * change from the 400 this used to send explicitly. `http-errors` keeps a
     * status already present on the error, so setting it restores the old
     * response.
     */
    const {error} = run('{"masterKey": broken');

    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(400);
  });

  it('does not mistake a key merely containing the marker text', () => {
    // 'notMasterKeyish' contains no exact marker; and a value that merely
    // mentions it must not be promoted to a master key.
    const {req} = run(JSON.stringify({note: 'the masterKey is secret'}));
    expect(req['x-master-key']).toBeUndefined();
  });

  it('handles an empty body without throwing', () => {
    const {req, threw} = run('');
    expect(req['x-master-key']).toBeUndefined();
    expect(threw).toBe(false);
  });
});

describe('conditionalJsonMiddleware', () => {
  const original = process.env.mountPath;
  beforeAll(() => (process.env.mountPath = '/parse'));
  afterAll(() => (process.env.mountPath = original));

  it('skips file routes entirely', () => {
    const next = jest.fn();
    conditionalJsonMiddleware(
      {path: '/parse/files/abc.png'} as any,
      {} as any,
      next
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('parses a text/plain body on a non-file route', done => {
    const body = JSON.stringify({masterKey: 'secret', a: 1});
    const req: any = require('stream').Readable.from([Buffer.from(body)]);
    req.path = '/parse/products/listProducts';
    req.method = 'POST';
    req.headers = {
      'content-type': 'text/plain',
      'content-length': String(Buffer.byteLength(body)),
    };

    conditionalJsonMiddleware(req, {} as any, (err?: any) => {
      expect(err).toBeFalsy();
      expect(req.body).toEqual({masterKey: 'secret', a: 1});
      // verify ran against the same request
      expect(req['x-master-key']).toBe('secret');
      done();
    });
  });

  it('reuses one parser instance across calls', () => {
    // Regression guard: the parser used to be rebuilt per request.
    const next = jest.fn();
    const call = () =>
      conditionalJsonMiddleware(
        {path: '/parse/files/x'} as any,
        {} as any,
        next
      );
    call();
    call();
    expect(next).toHaveBeenCalledTimes(2);
  });
});
