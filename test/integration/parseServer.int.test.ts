import express from 'express';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {
  getSchemaDefinition,
  ParseClass,
  ParseField,
} from '../../src/decorators/parseDecorators';
import {ParseVersionField} from '../../src/database/versionRegistry';
import {
  createVersionedMongoAdapter,
  VERSION_CONFLICT,
  VERSION_CONFLICT_MESSAGE,
} from '../../src/database/versionedMongoAdapter';
import {withTransaction} from '../../src/transactions/context';

/**
 * The whole stack, for real: parse-server (the installed version, no mocks),
 * its own mongodb driver, an in-memory replica set, and this library's adapter
 * plugged in as `databaseAdapter`.
 *
 * This is the test that breaks when a parse-server upgrade moves any of the
 * internals the library leans on: the `MongoStorageAdapter` module path,
 * `_adaptiveCollection` / `_mongoCollection`, `_getSaveJSON`, or the driver's
 * options positions (`OPTIONS_ARGUMENT`).
 */

/**
 * The SDK as `any`: the repo's minimal Parse typings cover models, not the
 * client surface (initialize, Cloud.run, query options) used here.
 *
 * Read through a getter rather than captured once, because **there are two
 * copies of the Parse SDK in the tree**: the one this package depends on, and
 * `parse-server/node_modules/parse` — parse-server pins an exact version and
 * npm nests it when it disagrees with the top level. Requiring parse-server
 * REPLACES `global.Parse` with its own copy, and only that copy has
 * `Cloud.define`. Capturing the global at module load therefore grabs the copy
 * that is about to be discarded.
 */
const P: any = new Proxy(
  {},
  {
    get: (_target, key) => (global as Record<string, any>).Parse[key],
  }
);

@ParseClass('ITJob')
class ITJob extends Parse.Object {
  constructor() {
    super('ITJob');
  }

  @ParseField({type: 'String'})
  title!: string;

  @ParseVersionField()
  version!: number;
}

const APP_ID = 'kit-integration';
const MASTER_KEY = 'kit-master-key';
const MASTER = {useMasterKey: true};

let replSet: MongoMemoryReplSet;
let httpServer: Server;
let parseServer: any;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({replSet: {count: 1}});

  const app = express();
  httpServer = await new Promise<Server>(resolve => {
    const server = app.listen(0, () => resolve(server));
  });
  const port = (httpServer.address() as AddressInfo).port;
  const serverURL = `http://127.0.0.1:${port}/parse`;

  /* eslint-disable @typescript-eslint/no-var-requires */
  const {ParseServer} = require('parse-server');
  const {
    GridFSBucketAdapter,
  } = require('parse-server/lib/Adapters/Files/GridFSBucketAdapter');
  /* eslint-enable @typescript-eslint/no-var-requires */
  parseServer = new ParseServer({
    appId: APP_ID,
    masterKey: MASTER_KEY,
    serverURL,
    databaseAdapter: createVersionedMongoAdapter({
      uri: replSet.getUri('parsekit'),
      collectionPrefix: '',
      mongoOptions: {},
    }),
    // parse-server ≥ 9 insists on an explicit filesAdapter whenever the
    // database adapter is explicit.
    filesAdapter: new GridFSBucketAdapter(replSet.getUri('parsekit')),
    // Without directAccess a save inside cloud code detours through HTTP and
    // loses the ambient transaction — the config the library documents.
    directAccess: true,
    // The schema built from the decorators, so `version` exists as a Number
    // from the start — the same path a consuming app uses.
    schema: {definitions: [getSchemaDefinition(ITJob)]},
    silent: true,
  });
  await parseServer.start();
  app.use('/parse', parseServer.app);

  P.initialize(APP_ID, undefined, MASTER_KEY);
  P.serverURL = serverURL;
}, 180000);

afterAll(async () => {
  try {
    // Throws on the HTTP server it expects to own — we mounted its app on our
    // own express instead. The adapters it does own still get closed first.
    await parseServer?.handleShutdown();
  } catch {
    // jest runs with forceExit; leftover handles are expected.
  }
  await new Promise(resolve => httpServer?.close(resolve));
  await replSet?.stop();
});

describe('optimistic locking through a real parse-server', () => {
  let jobId: string;

  it('a create gets version 1 from the adapter, unasked', async () => {
    const job = new ITJob();
    job.set('title', 'first draft');
    await job.save(null, MASTER);
    jobId = job.id;

    const fetched = await new P.Query('ITJob').get(jobId, MASTER);
    expect(fetched.get('version')).toBe(1);
    expect(fetched.get('title')).toBe('first draft');
  });

  it('every update moves the version on', async () => {
    const job = await new P.Query('ITJob').get(jobId, MASTER);
    job.set('title', 'second draft');
    await job.save(null, MASTER);

    const fetched = await new P.Query('ITJob').get(jobId, MASTER);
    expect(fetched.get('version')).toBe(2);
    expect(fetched.get('title')).toBe('second draft');
  });

  it('the second of two racing saves is refused with the conflict error', async () => {
    const copy1 = await new P.Query('ITJob').get(jobId, MASTER);
    const copy2 = await new P.Query('ITJob').get(jobId, MASTER);

    copy1.set('title', 'copy1 wins');
    await copy1.save(null, MASTER);

    copy2.set('title', 'copy2 would clobber');
    await expect(copy2.save(null, MASTER)).rejects.toMatchObject({
      code: VERSION_CONFLICT,
      message: VERSION_CONFLICT_MESSAGE,
    });

    // The losing save changed nothing.
    const fetched = await new P.Query('ITJob').get(jobId, MASTER);
    expect(fetched.get('title')).toBe('copy1 wins');
  });

  it('rereading and redoing the change is exactly the recovery', async () => {
    const fresh = await new P.Query('ITJob').get(jobId, MASTER);
    fresh.set('title', 'copy2, after rereading');
    await fresh.save(null, MASTER);

    const fetched = await new P.Query('ITJob').get(jobId, MASTER);
    expect(fetched.get('title')).toBe('copy2, after rereading');
  });

  it('saveAll asserts versions too — _getSaveJSON is the shared path', async () => {
    const job = await new P.Query('ITJob').get(jobId, MASTER);
    const stale = await new P.Query('ITJob').get(jobId, MASTER);

    job.set('title', 'moved on');
    await P.Object.saveAll([job], MASTER);

    stale.set('title', 'stale batch');
    await expect(P.Object.saveAll([stale], MASTER)).rejects.toMatchObject({
      code: VERSION_CONFLICT,
    });
  });
});

describe('ambient transactions through a real cloud function', () => {
  beforeAll(async () => {
    P.Cloud.define('kitTxn', async (request: any) => {
      return withTransaction(async () => {
        const first = new P.Object('TxnDoc');
        first.set('n', 1);
        await first.save(null, MASTER);

        const second = new P.Object('TxnDoc');
        second.set('n', 2);
        await second.save(null, MASTER);

        if (request.params.fail) {
          throw new Error('deliberate failure after two saves');
        }
        return 'committed';
      });
    });

    // Create the class outside any transaction, so the rollback test is about
    // the documents and not about collection creation.
    const seed = new P.Object('TxnDoc');
    seed.set('n', 0);
    await seed.save(null, MASTER);
    await seed.destroy(MASTER);
  });

  it('a failing function leaves nothing behind — both saves rolled back', async () => {
    await expect(P.Cloud.run('kitTxn', {fail: true})).rejects.toThrow();

    const rows = await new P.Query('TxnDoc').find(MASTER);
    expect(rows).toHaveLength(0);
  });

  it('a successful function lands both writes together', async () => {
    await expect(P.Cloud.run('kitTxn', {})).resolves.toBe('committed');

    const rows = await new P.Query('TxnDoc').find(MASTER);
    expect(rows.map((row: any) => row.get('n')).sort()).toEqual([1, 2]);
  });
});
