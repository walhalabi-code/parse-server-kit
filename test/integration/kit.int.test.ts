import {start, stop, api, MOUNT, APP_ID, MASTER_KEY, PORT, indexesOf, collectionOf, parseServerInstance} from './harness';
import {applyAllIndexes} from '../../src';
import {
  implementACL,
  syncImageAcl,
  cloneAcl,
  catchError,
  generateSwaggerSpec,
  VersionRegistry,
  CronRegistry,
  Cron,
  CronSchedule,
  CONFLICT,
  inTransaction,
  withTransaction,
  configureRoleCache,
  invalidateRoles,
  roleCacheStats,
} from '../../src';

import {SmokeWidget, SmokeTag, SmokeDoc, SmokeStock, SmokeLedger, triggerLog} from './models';
import {callLog} from './functions';
import './functions';

/**
 * The whole library, end to end, against a real Parse Server on a real MongoDB
 * replica set. Nothing here is mocked — a pass means the feature worked against
 * the database, not that a unit test agreed with itself.
 *
 * This is where transactions and `@ParseVersionField` are actually exercised.
 * Both need a replica set, both fail silently when misconfigured, and neither
 * can be covered by the unit suite.
 */

let cronRan = 0;

class SmokeJobs {
  @Cron({schedule: CronSchedule.YEARLY, description: 'Integration job'})
  static async smokeJob() {
    cronRan += 1;
  }
}
void SmokeJobs;

let tagA: SmokeTag;
let tagB: SmokeTag;

beforeAll(async () => {
  await start();

  tagA = new SmokeTag();
  tagA.label = 'A';
  await tagA.save(null, {useMasterKey: true});

  tagB = new SmokeTag();
  tagB.label = 'B';
  await tagB.save(null, {useMasterKey: true});
}, 180000);

afterAll(async () => {
  await stop();
});

/** A unique sku per call, so ordering never matters. */
let counter = 0;
const sku = (prefix: string) => `${prefix}-${Date.now()}-${counter++}`;

describe('schema and indexes', () => {
  it('registers models as their own Parse subclasses', () => {
    const row = Parse.Object.fromJSON({className: 'SmokeWidget'} as any, true);
    expect(row).toBeInstanceOf(SmokeWidget);
  });

  /*
   * What `applyAllIndexes` actually left on the collection.
   *
   * The suite used to prove only that it did not throw, plus one behavioural
   * check (a duplicate sku is rejected). That misses the whole class of bug
   * where an index is created and then dropped again, or never created at all
   * — which is exactly what happened: the unique pass dropped any non-unique
   * index CONTAINING its field, compound ones included, and the later compound
   * pass quietly rebuilt them. Nothing failed, and every boot churned.
   */
  it('leaves every declared index on the collection', async () => {
    const indexes = await indexesOf('SmokeWidget');

    // Unique, single-field — from @ParseField({unique: true}).
    expect(indexes['sku_unique']).toMatchObject({
      key: {sku: 1},
      unique: true,
    });

    // Compound, disjoint from the unique field.
    expect(indexes['status_createdAt_index']).toMatchObject({
      key: {status: 1, createdAt: 1},
    });

    // 2dsphere — from @ParseField({type: 'GeoPoint', geo: true}).
    expect(indexes['where_2dsphere']).toMatchObject({key: {where: '2dsphere'}});
  });

  /*
   * The regression that the check above CANNOT see.
   *
   * `applyAllIndexes` runs the unique pass first and the compound pass second,
   * so an index the compound pass owns is rebuilt in the same run it was
   * wrongly dropped in. The end state looks correct and the assertion above
   * passes even with the bug present — verified by reverting the fix.
   *
   * What does not come back is an index this library never declared. A DBA's
   * index, or one from an earlier schema, containing the unique field was
   * dropped on every boot and rebuilt by nobody. That is the permanent loss,
   * so that is what this pins: create a foreign index, re-run the pass, and
   * require it to still be there.
   */
  it('does not drop an index it does not manage', async () => {
    const collection = await collectionOf('SmokeWidget');
    await collection.createIndex(
      {sku: 1, name: 1},
      {name: 'sku_name_foreign', background: true}
    );

    // Idempotent by design, so re-running is exactly what a restart does.
    await applyAllIndexes(parseServerInstance());

    const after = await indexesOf('SmokeWidget');
    expect(after['sku_name_foreign']).toMatchObject({key: {sku: 1, name: 1}});

    // And the library's own indexes are still intact alongside it.
    expect(after['sku_unique']).toMatchObject({unique: true});
    expect(after['status_createdAt_index']).toBeDefined();
  });

  it('creates a unique index that rejects a duplicate', async () => {
    const first = new SmokeWidget();
    first.name = 'Alpha';
    first.sku = 'fixed-duplicate-sku';
    await first.save(null, {useMasterKey: true});

    const second = new SmokeWidget();
    second.name = 'Beta';
    second.sku = 'fixed-duplicate-sku';
    const [err] = await catchError(second.save(null, {useMasterKey: true}));

    expect(err).toBeTruthy();
  });
});

describe('validation', () => {
  const rejects = async (build: (w: SmokeWidget) => void) => {
    const widget = new SmokeWidget();
    widget.name = 'Valid name';
    widget.sku = sku('v');
    build(widget);
    const [err] = await catchError(widget.save(null, {useMasterKey: true}));
    return err;
  };

  it('rejects a missing required field', async () => {
    const widget = new SmokeWidget();
    widget.sku = sku('req');
    const [err] = await catchError(widget.save(null, {useMasterKey: true}));
    expect(err).toBeTruthy();
  });

  it('rejects a value outside an enum', async () => {
    expect(await rejects(w => (w.status = 'not-a-status'))).toBeTruthy();
  });

  it('rejects a number above max', async () => {
    expect(await rejects(w => (w.price = 99999))).toBeTruthy();
  });

  it('rejects a string below minLength', async () => {
    expect(await rejects(w => (w.name = 'x'))).toBeTruthy();
  });

  it('rejects a string breaking a pattern', async () => {
    expect(await rejects(w => (w.slug = 'NOT A SLUG'))).toBeTruthy();
  });
});

describe('triggers', () => {
  it('runs beforeSave and applies its defaults', async () => {
    const before = triggerLog.beforeSave;
    const widget = new SmokeWidget();
    widget.name = 'Trigger test';
    widget.sku = sku('trig');
    await widget.save(null, {useMasterKey: true});

    expect(triggerLog.beforeSave).toBeGreaterThan(before);
    expect(widget.status).toBe('draft');
  });

  it('runs afterSave', () => {
    expect(triggerLog.afterSave).toBeGreaterThan(0);
  });

  it('runs beforeFind', async () => {
    const before = triggerLog.beforeFind;
    await new Parse.Query(SmokeWidget).limit(1).find({useMasterKey: true});
    expect(triggerLog.beforeFind).toBeGreaterThan(before);
  });

  it('runs beforeDelete', async () => {
    const before = triggerLog.beforeDelete;
    const widget = new SmokeWidget();
    widget.name = 'Delete me';
    widget.sku = sku('del');
    await widget.save(null, {useMasterKey: true});
    await widget.destroy({useMasterKey: true});
    expect(triggerLog.beforeDelete).toBeGreaterThan(before);
  });

  it('never registers a trigger declared without @ParseClass', async () => {
    // SmokeOrphan's trigger throws if it ever fires, so a clean save proves it
    // was never registered.
    const Orphan = Parse.Object.extend('SmokeOrphan');
    const row: any = new Orphan();
    row.set('anything', 1);
    const [err] = await catchError(row.save(null, {useMasterKey: true}));
    expect(err).toBeUndefined();
  });
});

describe('fromParams', () => {
  it('builds a pointer from a bare id string, and it is queryable', async () => {
    // The shape a browser sends for a select field. This used to produce a
    // pointer with id: undefined — looked right, matched nothing.
    const doc = SmokeDoc.fromParams({title: 'Bare id', tag: tagA.id});
    expect((doc.get('tag') as any).id).toBe(tagA.id);

    await doc.save(null, {useMasterKey: true});
    const found = await new Parse.Query(SmokeDoc)
      .equalTo('tag', tagA)
      .first({useMasterKey: true});
    expect(found).toBeTruthy();
  });

  it('builds pointers from an array of bare ids', () => {
    const doc = SmokeDoc.fromParams({tags: [tagA.id, tagB.id]});
    const tags: any[] = doc.get('tags');
    expect(tags.map(t => t.id)).toEqual([tagA.id, tagB.id]);
  });

  it('throws rather than building a pointer with no id', () => {
    expect(() => SmokeDoc.fromParams({tag: {nothing: 'useful'}})).toThrow();
  });

  it('converts an ISO string to a Date', () => {
    const doc = SmokeDoc.fromParams({publishedAt: '2026-09-01T09:00:00.000Z'});
    expect(doc.get('publishedAt')).toBeInstanceOf(Date);
  });

  it('converts a lat/long object to a GeoPoint', () => {
    const doc = SmokeDoc.fromParams({spot: {latitude: 24.7136, longitude: 46.6753}});
    expect(doc.get('spot')).toBeInstanceOf(Parse.GeoPoint);
  });

  it('never builds a pointer for an excluded target class', () => {
    const doc = SmokeDoc.fromParams({cover: 'some-image-id'});
    const value: any = doc.get('cover');
    expect(typeof value === 'object' && value !== null).toBe(false);
    expect((doc as any)._getSaveJSON().cover).toBeUndefined();
  });

  it('leaves an Array without targetClass as raw values', () => {
    const doc = SmokeDoc.fromParams({rawList: ['x', 'y']});
    expect(doc.get('rawList')).toEqual(['x', 'y']);
  });

  it('never writes an undeclared key, though a trigger can still read it', () => {
    const doc = SmokeDoc.fromParams({title: 'ok', notAField: 'should not land'});
    const payload = (doc as any)._getSaveJSON();
    expect(payload.notAField).toBeUndefined();
    expect(payload.title).toBe('ok');
  });

  it('clears a pointer given null', () => {
    expect(SmokeDoc.fromParams({tag: null}).get('tag')).toBeNull();
  });
});

describe('permissions', () => {
  it('returns an ACL describing exactly the grants asked for', () => {
    const acl: any = implementACL({
      publicRead: true,
      roleRules: [{role: 'Admin', read: true, write: true}],
      owner: [{user: 'user-1', read: true, write: false}],
    }).toJSON();

    expect(acl['*']).toEqual({read: true});
    expect(acl['role:Admin']).toEqual({read: true, write: true});
    expect(acl['user-1']).toEqual({read: true});
  });

  it('actually hides a row from an anonymous reader', async () => {
    const hidden = new SmokeWidget();
    hidden.name = 'Hidden widget';
    hidden.sku = sku('hidden');
    hidden.setACL(implementACL({roleRules: [{role: 'Admin', read: true, write: true}]}));
    await hidden.save(null, {useMasterKey: true});

    // No session token, so the ACL — not a where clause — must exclude it.
    const found = await new Parse.Query(SmokeWidget).equalTo('objectId', hidden.id).first();
    expect(found).toBeFalsy();
  });

  it('copies a parent ACL onto nested pointers', () => {
    const parent = new SmokeDoc();
    parent.setACL(implementACL({publicRead: true, roleRules: [{role: 'Admin', read: true, write: true}]}));
    const child = new SmokeTag();
    parent.set('tag', child);

    syncImageAcl(parent as any, ['tag']);
    expect(child.getACL()!.toJSON()).toEqual(parent.getACL()!.toJSON());
  });

  it('clones an ACL rather than aliasing it', () => {
    const original = implementACL({publicRead: true});
    const copy = cloneAcl(original);
    copy.setPublicReadAccess(false);
    expect(original.getPublicReadAccess()).toBe(true);
  });
});

describe('routing and middleware', () => {
  it('resolves a route from the method name', async () => {
    const res = await api(`${MOUNT}/smoke-widgets/createSmokeWidget`, {
      method: 'POST',
      body: {name: 'Routed widget', sku: sku('route')},
    });
    expect(res.status).toBe(200);
    expect(res.body.objectId).toBeTruthy();
  });

  it('delivers GET parameters as strings', async () => {
    const res = await api(`${MOUNT}/smoke-widgets/listSmokeWidgets?limit=2&status=draft`);
    expect(res.status).toBe(200);
    expect(res.body.limitWasString).toBe(true);
    expect(res.body.count).toBeLessThanOrEqual(2);
  });

  it('refuses the wrong HTTP method with 405', async () => {
    const res = await api(`${MOUNT}/smoke-widgets/listSmokeWidgets`, {method: 'POST', body: {}});
    expect(res.status).toBe(405);
  });

  it('refuses a caller without the required role', async () => {
    const res = await api(`${MOUNT}/smoke-widgets/gatedSmokeWidget`, {method: 'POST', body: {}});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.reached).toBeUndefined();
  });

  it('refuses an anonymous caller when requireUser is set', async () => {
    const res = await api(`${MOUNT}/smoke-widgets/authedSmokeWidget`, {method: 'POST', body: {}});
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('blocks /classes and explains why', async () => {
    const res = await api(`${MOUNT}/classes/SmokeWidget`);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Route not allowed');
    expect(res.body.detail).toContain('/classes');
  });

  it('blocks /login and names allowAuthRoutes', async () => {
    const res = await api(`${MOUNT}/login`, {method: 'POST', body: {username: 'x', password: 'y'}});
    expect(res.status).toBe(403);
    expect(res.body.detail).toContain('allowAuthRoutes');
  });

  it('lets the master key past', async () => {
    const res = await api(`${MOUNT}/classes/SmokeWidget`, {master: true});
    expect(res.status).toBe(200);
  });

  it('leaves /health open', async () => {
    expect((await api(`${MOUNT}/health`)).status).toBe(200);
  });
});

describe('transactions', () => {
  it('commits every write in the body', async () => {
    const note = `commit-${Date.now()}`;
    const res = await api(`${MOUNT}/smoke-widgets/smokeTransfer`, {method: 'POST', body: {note}});
    expect(res.status).toBe(200);

    const rows = await new Parse.Query(SmokeLedger)
      .startsWith('note', note)
      .find({useMasterKey: true});
    expect(rows).toHaveLength(2);
  });

  it('rolls back an earlier write when the body throws', async () => {
    const note = `rollback-${Date.now()}`;
    const res = await api(`${MOUNT}/smoke-widgets/smokeTransfer`, {
      method: 'POST',
      body: {note, shouldFail: 'true'},
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const rows = await new Parse.Query(SmokeLedger)
      .startsWith('note', note)
      .find({useMasterKey: true});
    expect(rows).toHaveLength(0);
  });

  it('opened a transaction at all, so the decorator order is right', () => {
    expect(callLog.transactionAttempts).toBeGreaterThan(0);
  });

  it('reports ambient state accurately', async () => {
    expect(inTransaction()).toBe(false);
    let inside = false;
    await withTransaction(async () => {
      inside = inTransaction();
    });
    expect(inside).toBe(true);
  });
});

describe('optimistic locking', () => {
  it('installs the versioned adapter', () => {
    expect(VersionRegistry.adapterIsInstalled()).toBe(true);
    expect(VersionRegistry.isVersioned('SmokeStock')).toBe(true);
  });

  it('starts a new row at version 1', async () => {
    const stock = new SmokeStock();
    stock.name = 'Fresh stock';
    stock.units = 5;
    await stock.save(null, {useMasterKey: true});

    const loaded = await new Parse.Query(SmokeStock).get(stock.id, {useMasterKey: true});
    expect(loaded.get('version')).toBe(1);
  });

  it('refuses a lost race with CONFLICT rather than overwriting', async () => {
    const stock = new SmokeStock();
    stock.name = 'Contended';
    stock.units = 1;
    await stock.save(null, {useMasterKey: true});

    // Two independent reads, both at version 1.
    const first = (await new Parse.Query(SmokeStock).get(stock.id, {useMasterKey: true})) as SmokeStock;
    const second = (await new Parse.Query(SmokeStock).get(stock.id, {useMasterKey: true})) as SmokeStock;

    first.units = 0;
    await first.save(null, {useMasterKey: true}); // wins

    second.units = 0;
    const [err] = await catchError(second.save(null, {useMasterKey: true})); // must lose

    expect(err).toBeTruthy();
    expect((err as any).code).toBe(CONFLICT);
  });

  it('advances the version on a successful update', async () => {
    const stock = new SmokeStock();
    stock.name = 'Increment';
    stock.units = 3;
    await stock.save(null, {useMasterKey: true});

    const loaded = (await new Parse.Query(SmokeStock).get(stock.id, {useMasterKey: true})) as SmokeStock;
    loaded.units = 2;
    await loaded.save(null, {useMasterKey: true});

    const after = await new Parse.Query(SmokeStock).get(stock.id, {useMasterKey: true});
    expect(after.get('version')).toBe(2);
  });
});

describe('cron', () => {
  it('registers the job', () => {
    expect(CronRegistry.getJob('smokeJob')).toBeTruthy();
  });

  it('runs the body on demand', async () => {
    const before = cronRan;
    await CronRegistry.runNow('smokeJob');
    expect(cronRan).toBeGreaterThan(before);
  });

  it('stops and starts a job', () => {
    expect(CronRegistry.stopJob('smokeJob')).toBe(true);
    expect(CronRegistry.startJob('smokeJob')).toBe(true);
  });
});

describe('OpenAPI', () => {
  const spec = () => generateSwaggerSpec({title: 'Kit', version: '1.0.0', basePath: MOUNT}) as any;

  it('documents the registered routes and models', () => {
    const doc = spec();
    expect(Object.keys(doc.paths).some(p => p.includes('createSmokeWidget'))).toBe(true);
    const schemas = doc.components?.schemas ?? doc.definitions ?? {};
    expect(schemas.SmokeWidget).toBeTruthy();
  });

  it('gives a GET route query parameters, not a request body', () => {
    const doc = spec();
    const entry = Object.entries<any>(doc.paths).find(([p]) => p.includes('listSmokeWidgets'));
    expect(entry).toBeTruthy();
    expect(entry![1].get).toBeTruthy();
    expect(entry![1].get.requestBody).toBeFalsy();
  });
});

describe('files', () => {
  const CONTENT = 'the quick brown fox';
  const base64 = Buffer.from(CONTENT).toString('base64');

  it('saves through the GridFS adapter and hands back a URL', async () => {
    const file = new Parse.File('smoke.txt', {base64});
    await file.save({useMasterKey: true});

    const url = file.url();
    expect(url).toContain('smoke.txt');
    expect(url).toMatch(/^https?:\/\//);
  });

  it('round-trips as a field on an object', async () => {
    const file = new Parse.File('attached.txt', {base64});
    await file.save({useMasterKey: true});

    const doc = new SmokeDoc();
    doc.title = 'Has an attachment';
    doc.attachment = file;
    await doc.save(null, {useMasterKey: true});

    const loaded = await new Parse.Query(SmokeDoc).get(doc.id, {useMasterKey: true});
    const back: any = loaded.get('attachment');
    expect(back).toBeTruthy();
    expect(back.name()).toContain('attached.txt');
  });

  it('serves the bytes back unchanged', async () => {
    const file = new Parse.File('readable.txt', {base64});
    await file.save({useMasterKey: true});

    const response = await fetch(file.url(), {
      headers: {'X-Parse-Application-Id': APP_ID, 'X-Parse-Master-Key': MASTER_KEY},
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(CONTENT);
  });

  it('leaves an attachment out of the payload when nothing changed', async () => {
    // Files are expensive to rewrite. A save that did not touch the field must
    // not resend it — the same dirty-tracking that keeps undeclared keys out.
    const file = new Parse.File('untouched.txt', {base64});
    await file.save({useMasterKey: true});

    const doc = new SmokeDoc();
    doc.attachment = file;
    await doc.save(null, {useMasterKey: true});

    doc.title = 'Only the title changed';
    expect((doc as any)._getSaveJSON().attachment).toBeUndefined();
  });
});

describe('LiveQuery', () => {
  /**
   * The SDK has to be configured as a *client* for a subscription: parse-server
   * short-circuits ordinary saves through directAccess, but a WebSocket needs a
   * real URL to connect to. Done here rather than in the harness so it cannot
   * affect any test above.
   */
  beforeAll(() => {
    const P = Parse as any;
    P.initialize(APP_ID);
    P.masterKey = MASTER_KEY;
    P.serverURL = `http://127.0.0.1:${PORT}${MOUNT}`;
    P.liveQueryServerURL = `ws://127.0.0.1:${PORT}`;
  });

  /** Wait for one event, or fail with a message rather than a timeout. */
  const nextEvent = (subscription: any, name: string, ms = 8000) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no "${name}" event within ${ms}ms`)),
        ms
      );
      subscription.on(name, (obj: any) => {
        clearTimeout(timer);
        resolve(obj);
      });
    });

  it('delivers a create event to a subscriber', async () => {
    const query = new Parse.Query(SmokeDoc).equalTo('title', 'live-create');
    const subscription: any = await (query as any).subscribe();

    try {
      await nextEvent(subscription, 'open');

      const created = nextEvent(subscription, 'create');
      const doc = new SmokeDoc();
      doc.title = 'live-create';
      doc.setACL(implementACL({publicRead: true, publicWrite: true}));
      await doc.save(null, {useMasterKey: true});

      const event = await created;
      expect(event.get('title')).toBe('live-create');
    } finally {
      subscription.unsubscribe();
    }
  }, 30000);

  it('delivers an update event', async () => {
    const doc = new SmokeDoc();
    doc.title = 'live-update';
    doc.setACL(implementACL({publicRead: true, publicWrite: true}));
    await doc.save(null, {useMasterKey: true});

    const query = new Parse.Query(SmokeDoc).equalTo('objectId', doc.id);
    const subscription: any = await (query as any).subscribe();

    try {
      await nextEvent(subscription, 'open');

      const updated = nextEvent(subscription, 'update');
      doc.title = 'live-update-changed';
      await doc.save(null, {useMasterKey: true});

      const event = await updated;
      expect(event.get('title')).toBe('live-update-changed');
    } finally {
      subscription.unsubscribe();
    }
  }, 30000);

  it('never delivers a row the subscriber may not read', async () => {
    // The point of the whole feature: a subscription is scoped by the same ACL
    // as a query, so there is no second permission model to keep in step.
    const query = new Parse.Query(SmokeDoc).equalTo('title', 'live-private');
    const subscription: any = await (query as any).subscribe();

    try {
      await nextEvent(subscription, 'open');

      let leaked = false;
      subscription.on('create', () => {
        leaked = true;
      });

      const secret = new SmokeDoc();
      secret.title = 'live-private';
      // Readable only by a role this anonymous subscriber does not hold.
      secret.setACL(implementACL({roleRules: [{role: 'Admin', read: true, write: true}]}));
      await secret.save(null, {useMasterKey: true});

      // Give it clearly longer than the events above took to arrive.
      await new Promise(resolve => setTimeout(resolve, 2500));
      expect(leaked).toBe(false);
    } finally {
      subscription.unsubscribe();
    }
  }, 30000);
});

describe('role cache', () => {
  afterEach(() => configureRoleCache(false));

  it('is off until asked for', () => {
    expect(roleCacheStats().enabled).toBe(false);
  });

  it('turns on, and invalidate empties it', () => {
    configureRoleCache({ttlMs: 5000});
    expect(roleCacheStats().enabled).toBe(true);
    invalidateRoles();
    expect(roleCacheStats().size).toBe(0);
  });
});
