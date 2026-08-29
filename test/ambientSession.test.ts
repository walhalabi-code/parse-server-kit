import {
  NO_AMBIENT_TRANSACTION,
  withAmbientSession,
} from '../src/transactions/ambientSession';
import {useTransactionAdapter, withTransaction} from '../src/transactions/context';

/**
 * `withAmbientSession` — the proxy that makes a raw driver collection join
 * whatever transaction the calling code is in, at call time.
 */

function fakeCollection() {
  return {
    collectionName: 'jobs',
    find: jest.fn().mockReturnValue('cursor'),
    findOne: jest.fn().mockResolvedValue(null),
    updateOne: jest.fn().mockResolvedValue({}),
    insertOne: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({}),
    aggregate: jest.fn().mockReturnValue('cursor'),
    countDocuments: jest.fn().mockResolvedValue(0),
    // Not in the injection table — must pass through untouched.
    createIndex: jest.fn().mockResolvedValue('ok'),
    // A method that depends on `this` staying bound to the raw collection.
    whoAmI: jest.fn().mockReturnThis(),
  };
}

/** Run the body inside a real ambient transaction, and hand back its session. */
async function inSession(body: () => void | Promise<void>): Promise<object> {
  const session = {kind: 'session'};
  useTransactionAdapter({
    connect: async () => undefined,
    createTransactionalSession: async () => session,
    commitTransactionalSession: async () => undefined,
    abortTransactionalSession: async () => undefined,
  });
  await withTransaction(async () => {
    await body();
  });
  return session;
}

describe('withAmbientSession outside any transaction', () => {
  it('calls through with the arguments untouched', () => {
    const raw = fakeCollection();
    const wrapped = withAmbientSession(raw);

    wrapped.find({a: 1});
    expect(raw.find).toHaveBeenCalledWith({a: 1});

    wrapped.updateOne({a: 1}, {$set: {b: 2}}, {upsert: true});
    expect(raw.updateOne).toHaveBeenCalledWith({a: 1}, {$set: {b: 2}}, {upsert: true});
  });

  it('returns non-function properties as they are', () => {
    const wrapped = withAmbientSession(fakeCollection());
    expect(wrapped.collectionName).toBe('jobs');
  });

  it('keeps pass-through methods bound to the raw collection', () => {
    const raw = fakeCollection();
    const wrapped = withAmbientSession(raw);
    expect(wrapped.whoAmI()).toBe(raw);
  });
});

describe('withAmbientSession inside a transaction', () => {
  it('injects the session at each method’s own options position', async () => {
    const raw = fakeCollection();
    const wrapped = withAmbientSession(raw);

    const session = await inSession(() => {
      wrapped.find({a: 1});
      wrapped.insertOne({doc: true});
      wrapped.updateOne({a: 1}, {$set: {b: 2}});
      wrapped.countDocuments({});
    });

    expect(raw.find).toHaveBeenCalledWith({a: 1}, {session});
    expect(raw.insertOne).toHaveBeenCalledWith({doc: true}, {session});
    expect(raw.updateOne).toHaveBeenCalledWith({a: 1}, {$set: {b: 2}}, {session});
    expect(raw.countDocuments).toHaveBeenCalledWith({}, {session});
  });

  it('reads the session at call time, not at wrap time', async () => {
    const raw = fakeCollection();
    // Wrapped long before any transaction exists — as the adapter caches them.
    const wrapped = withAmbientSession(raw);

    wrapped.find({early: true});
    expect(raw.find).toHaveBeenLastCalledWith({early: true});

    const session = await inSession(() => {
      wrapped.find({late: true});
    });
    expect(raw.find).toHaveBeenLastCalledWith({late: true}, {session});
  });

  it('keeps the caller’s other options, without mutating their object', async () => {
    const raw = fakeCollection();
    const wrapped = withAmbientSession(raw);
    const callerOptions: Record<string, unknown> = {upsert: true};

    const session = await inSession(() => {
      wrapped.updateOne({a: 1}, {$set: {b: 2}}, callerOptions);
    });

    expect(raw.updateOne).toHaveBeenCalledWith(
      {a: 1},
      {$set: {b: 2}},
      {upsert: true, session}
    );
    expect(callerOptions).toEqual({upsert: true});
  });

  it('lets a session threaded through by hand win', async () => {
    const raw = fakeCollection();
    const wrapped = withAmbientSession(raw);
    const handThreaded = {kind: 'their own session'};

    await inSession(() => {
      wrapped.find({a: 1}, {session: handThreaded, readPreference: 'secondary'});
    });

    // Both the foreign session and its readPreference survive.
    expect(raw.find).toHaveBeenCalledWith(
      {a: 1},
      {session: handThreaded, readPreference: 'secondary'}
    );
  });

  it('drops readPreference when the ambient session joins — transactions read primary', async () => {
    const raw = fakeCollection();
    const wrapped = withAmbientSession(raw);

    const session = await inSession(() => {
      wrapped.find({a: 1}, {readPreference: 'secondaryPreferred'});
    });

    expect(raw.find).toHaveBeenCalledWith({a: 1}, {session});
  });

  it('leaves methods outside the allowlist alone — no session, ever', async () => {
    const raw = fakeCollection();
    const wrapped = withAmbientSession(raw);

    await inSession(() => {
      wrapped.createIndex({a: 1}, {unique: true});
    });

    expect(raw.createIndex).toHaveBeenCalledWith({a: 1}, {unique: true});
  });
});

describe('NO_AMBIENT_TRANSACTION', () => {
  it('shields the system classes Parse writes as side effects', () => {
    for (const className of ['_SCHEMA', '_Idempotency', '_Hooks', '_JobStatus', '_GlobalConfig']) {
      expect(NO_AMBIENT_TRANSACTION.has(className)).toBe(true);
    }
    expect(NO_AMBIENT_TRANSACTION.has('Job')).toBe(false);
  });
});
