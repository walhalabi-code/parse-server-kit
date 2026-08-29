import type {Server} from 'node:http';
import express from 'express';
import {MongoClient} from 'mongodb';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
import {ParseServer} from 'parse-server';

import {
  CloudFunctionRegistry,
  TriggerRegistry,
  CronRegistry,
  validateEntityRoutes,
  restrictRoutes,
  removeResultMiddleware,
  conditionalJsonMiddleware,
  applyAllIndexes,
  applyMongoValidators,
  createSchemaConfig,
  createVersionedMongoAdapter,
  configureKit,
} from '../../src';

/**
 * A real Parse Server, on a real MongoDB replica set, with the library's
 * middleware mounted exactly as the documented boot order says.
 *
 * A replica set rather than a standalone server because transactions and
 * `@ParseVersionField` are the two features that cannot be tested without one —
 * and they are the two most likely to break silently.
 */

export const APP_ID = 'kit-integration';
export const MASTER_KEY = 'kit-integration-master-key';
export const MOUNT = '/api';
export const PORT = 1342;

let replSet: MongoMemoryReplSet | undefined;
let server: Server | undefined;
let mongo: MongoClient | undefined;
let uri: string | undefined;
let parse: unknown;

export interface Harness {
  databaseUri: string;
}

export async function start(): Promise<Harness> {
  replSet = await MongoMemoryReplSet.create({replSet: {count: 1, storageEngine: 'wiredTiger'}});
  const databaseUri = replSet.getUri('kit_integration');
  uri = databaseUri;

  configureKit({mountPath: MOUNT, masterKey: MASTER_KEY});

  /*
   * parse-server 9 refuses to boot with "When using an explicit database
   * adapter, you must also use an explicit filesAdapter", and every transaction
   * setup supplies a database adapter. GridFS is what a Mongo install would
   * have used anyway, so naming it changes nothing but the error.
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {GridFSBucketAdapter} = require('parse-server/lib/Adapters/Files/GridFSBucketAdapter');

  /*
   * Built as a plain object and cast, because parse-server's types and its
   * runtime disagree: ParseServerOptions marks `databaseURI` required and does
   * not special-case `databaseAdapter`, while passing both throws at runtime.
   */
  const options = {
    appId: APP_ID,
    masterKey: MASTER_KEY,
    maintenanceKey: 'kit-integration-maintenance-key',
    serverURL: `http://127.0.0.1:${PORT}${MOUNT}`,
    filesAdapter: new GridFSBucketAdapter(databaseUri),
    databaseAdapter: createVersionedMongoAdapter({
      uri: databaseUri,
      collectionPrefix: '',
      mongoOptions: {},
    }),
    allowClientClassCreation: false,
    // Without this a save() in cloud code becomes an internal HTTP request in a
    // fresh async context and writes OUTSIDE the transaction, with no symptom.
    directAccess: true,
    schema: createSchemaConfig({adminRole: 'Admin'}),
    silent: true,
    // A class only publishes LiveQuery events if it is named here. Leaving this
    // out is the usual reason a subscription connects and then never fires.
    liveQuery: {classNames: ['SmokeDoc']},
  };

  const parseServer = ParseServer(options as unknown as Parameters<typeof ParseServer>[0]);
  parse = parseServer;
  await parseServer.start();

  const app = express();
  app.use(removeResultMiddleware);
  app.use(MOUNT, validateEntityRoutes);
  app.use(conditionalJsonMiddleware);
  app.use(MOUNT, restrictRoutes);
  app.use(MOUNT, parseServer.app);

  // Registries AFTER the mount, or the routes are never built.
  CloudFunctionRegistry.initialize();
  TriggerRegistry.initialize();
  CronRegistry.initialize();

  server = app.listen(PORT);
  await new Promise(resolve => server!.once('listening', resolve));

  /*
   * LiveQuery rides on the same HTTP server as a WebSocket upgrade, so it can
   * only be created once that server is listening. In production it is often a
   * separate process — the point of testing it here is that a subscription
   * still respects the row ACL, which is independent of where it runs.
   */
  (ParseServer as unknown as {
    createLiveQueryServer: (s: Server, o?: unknown) => unknown;
  }).createLiveQueryServer(server, {appId: APP_ID, masterKey: MASTER_KEY});

  // Indexes and validators after listen().
  await applyAllIndexes(parseServer);
  await applyMongoValidators(parseServer);

  return {databaseUri};
}

export async function stop(): Promise<void> {
  server?.close();
  await mongo?.close();
  mongo = undefined;
  await replSet?.stop();
}

/**
 * The running Parse Server, for anything that needs to reach its adapter —
 * `applyAllIndexes` most of all, which takes it as its only argument.
 */
export function parseServerInstance(): any {
  if (!parse) throw new Error('parseServerInstance() needs start() to have run.');
  return parse;
}

/** The raw driver collection, for setting up state the library did not create. */
export async function collectionOf(className: string) {
  if (!uri) throw new Error('collectionOf() needs start() to have run.');
  if (!mongo) mongo = await new MongoClient(uri).connect();
  return mongo.db().collection(className);
}

/**
 * The indexes MongoDB actually holds for a class, keyed by name.
 *
 * Read straight from the driver rather than from the decorator metadata: the
 * metadata is the INTENT, and the whole point of `applyAllIndexes` is whether
 * the database ends up matching it. Asking the same source that produced the
 * intent would prove nothing.
 */
export async function indexesOf(
  className: string
): Promise<Record<string, Record<string, unknown>>> {
  if (!uri) throw new Error('indexesOf() needs start() to have run.');
  if (!mongo) mongo = await new MongoClient(uri).connect();

  const indexes = await mongo.db().collection(className).indexes();
  const byName: Record<string, Record<string, unknown>> = {};
  for (const index of indexes as any[]) {
    byName[index.name] = index;
  }
  return byName;
}

/** Call an endpoint the way a browser would. */
export async function api(
  path: string,
  options: {method?: string; body?: unknown; token?: string; master?: boolean} = {}
): Promise<{status: number; body: any}> {
  const headers: Record<string, string> = {
    'X-Parse-Application-Id': APP_ID,
    // What conditionalJsonMiddleware parses, matching Parse's own convention
    // of avoiding a CORS preflight on every write.
    'Content-Type': 'text/plain',
  };
  if (options.token) headers['X-Parse-Session-Token'] = options.token;
  if (options.master) headers['X-Parse-Master-Key'] = MASTER_KEY;

  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  try {
    return {status: response.status, body: JSON.parse(text)};
  } catch {
    return {status: response.status, body: text};
  }
}
