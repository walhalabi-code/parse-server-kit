import 'reflect-metadata';
import {
  configureRoleCache,
  invalidateRoles,
  roleCacheEnabled,
  roleCacheStats,
} from '../src/utils/roleCache';
import {getUserRoles} from '../src/utils/helper';

/**
 * The role cache trades freshness for a database round-trip, so the property
 * that matters most is the one about being OFF: with no `configureRoleCache`
 * call, every lookup must still hit the database exactly as it always did.
 *
 * `_Role` queries are counted by stubbing `Parse.Query`, so these assert the
 * number of round-trips rather than merely the answer.
 */

let queryCount = 0;
let rolesInDb: string[] = [];
let OriginalQuery: any;

function stubQuery() {
  OriginalQuery = (Parse as any).Query;
  (Parse as any).Query = class {
    constructor(public className: string) {}
    equalTo() { return this; }
    containedIn() { return this; }
    limit() { return this; }
    async find() {
      queryCount += 1;
      return rolesInDb.map(name => ({get: (k: string) => (k === 'name' ? name : undefined)}));
    }
  };
}

const user = (id: string) => ({id} as unknown as Parse.User);

beforeEach(() => {
  queryCount = 0;
  rolesInDb = ['Admin', 'Employee'];
  configureRoleCache(false);   // always start disabled
  stubQuery();
});

afterEach(() => {
  (Parse as any).Query = OriginalQuery;
  configureRoleCache(false);
});

describe('disabled by default', () => {
  it('is off unless configured', () => {
    expect(roleCacheEnabled()).toBe(false);
  });

  it('queries the database on every call', async () => {
    await getUserRoles(user('u1'));
    await getUserRoles(user('u1'));
    await getUserRoles(user('u1'));
    expect(queryCount).toBe(3);
  });

  it('still returns the right roles', async () => {
    expect(await getUserRoles(user('u1'))).toEqual(['Admin', 'Employee']);
  });
});

describe('enabled', () => {
  beforeEach(() => configureRoleCache({ttlMs: 60_000}));

  it('queries once, then serves from memory', async () => {
    await getUserRoles(user('u1'));
    await getUserRoles(user('u1'));
    await getUserRoles(user('u1'));
    expect(queryCount).toBe(1);
  });

  it('caches per user, not globally', async () => {
    await getUserRoles(user('u1'));
    await getUserRoles(user('u2'));
    expect(queryCount).toBe(2);
  });

  it('returns the same answer as an uncached lookup', async () => {
    const first = await getUserRoles(user('u1'));
    const second = await getUserRoles(user('u1'));
    expect(second).toEqual(first);
    expect(second).toEqual(['Admin', 'Employee']);
  });

  it('re-queries once the entry expires', async () => {
    configureRoleCache({ttlMs: 1});
    await getUserRoles(user('u1'));
    await new Promise(r => setTimeout(r, 5));
    await getUserRoles(user('u1'));
    expect(queryCount).toBe(2);
  });

  it('sees a revoked role after invalidateRoles', async () => {
    expect(await getUserRoles(user('u1'))).toEqual(['Admin', 'Employee']);

    rolesInDb = ['Employee'];                      // role revoked in the database
    expect(await getUserRoles(user('u1'))).toEqual(['Admin', 'Employee']);  // still stale

    invalidateRoles('u1');
    expect(await getUserRoles(user('u1'))).toEqual(['Employee']);
  });

  it('invalidateRoles() with no argument clears everyone', async () => {
    await getUserRoles(user('u1'));
    await getUserRoles(user('u2'));
    invalidateRoles();
    expect(roleCacheStats().size).toBe(0);
  });

  it('disabling drops everything held', async () => {
    await getUserRoles(user('u1'));
    expect(roleCacheStats().size).toBe(1);
    configureRoleCache(false);
    expect(roleCacheStats()).toMatchObject({enabled: false, size: 0});
  });

  it('evicts the oldest entry past maxUsers', async () => {
    configureRoleCache({ttlMs: 60_000, maxUsers: 2});
    await getUserRoles(user('u1'));
    await getUserRoles(user('u2'));
    await getUserRoles(user('u3'));
    expect(roleCacheStats().size).toBe(2);

    queryCount = 0;
    await getUserRoles(user('u1'));   // evicted — must re-query
    expect(queryCount).toBe(1);
  });
});

describe('configuration', () => {
  it('rejects a non-positive ttl rather than silently caching forever', () => {
    expect(() => configureRoleCache({ttlMs: 0})).toThrow(/positive number/);
    expect(() => configureRoleCache({ttlMs: -1})).toThrow(/positive number/);
  });

  it('reports its state', () => {
    configureRoleCache({ttlMs: 5000});
    expect(roleCacheStats()).toMatchObject({enabled: true, ttlMs: 5000});
  });
});
