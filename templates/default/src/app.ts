import 'reflect-metadata';
import express from 'express';
import {join} from 'path';
import {ParseServer} from 'parse-server';
import {
  importFiles,
  CloudFunctionRegistry,
  TriggerRegistry,
  CronRegistry,
  validateEntityRoutes,
  restrictRoutes,
  removeResultMiddleware,
  conditionalJsonMiddleware,
  setupSwagger,
  applyAllIndexes,
  applyMongoValidators,
  createSchemaConfig,
  configureKit,
} from 'parse-server-kit';

import {
  APP_ID,
  DATABASE_URI,
  IS_PRODUCTION,
  MAINTENANCE_KEY,
  MASTER_KEY,
  MOUNT_PATH,
  PORT,
  SEED_ON_BOOT,
  SERVER_URL,
} from './env';
import {mountDashboard} from './dashboard';
import {printBanner} from './banner';
import {seed, seedSampleData} from './seed';

/**
 * The boot sequence, and nothing else.
 *
 * The order below is load-bearing: each step depends on the one before it, and
 * getting it wrong mostly fails silently rather than throwing. Settings live in
 * `env.ts`, the admin console in `dashboard.ts`, and the startup output in
 * `banner.ts`, so that this file stays readable as a sequence.
 */

// Tell the kit both, rather than relying on it to read your environment.
// Without `masterKey` the master-key bypass in restrictRoutes never fires, and
// a caller with a valid master key is refused — silently.
configureKit({mountPath: MOUNT_PATH, masterKey: MASTER_KEY});

/**
 * Roles, the first admin, and (outside production) a demo user and some rows.
 *
 * Failures are reported, not thrown: a server that is up but unseeded is more
 * useful than one that refused to start, and the message says what to do.
 */
async function runSeed(): Promise<string | undefined> {
  const summary = await seed();
  if (IS_PRODUCTION) return undefined;

  await seedSampleData(summary);
  return summary.demoSessionToken;
}

async function main() {
  // 1. MODELS FIRST. @ParseClass calls Parse.Object.registerSubclass while the
  //    decorator is evaluated, so importing a model is what registers it. The
  //    global Parse must already exist, which importing parse-server above
  //    guarantees.
  //
  //    Note `.js` — these are the COMPILED files. Point importFiles at source
  //    and pass {extensions: ['.ts']}, or it silently imports nothing and the
  //    server starts with an empty schema.
  importFiles(join(__dirname, 'models'));
  importFiles(join(__dirname, 'functions'));

  // 2. Parse Server. The schema is built from the decorators just imported.
  //
  //    Called, not `new`ed — parse-server exports `ParseServer` as a callable
  //    factory `(options) => ParseServer`, so `new` is a type error.
  const parseServer = ParseServer({
    databaseURI: DATABASE_URI,
    appId: APP_ID,
    masterKey: MASTER_KEY,
    // Required by parse-server 9. Used for maintenance-only operations such as
    // setting createdAt/updatedAt directly; keep it secret and separate from
    // the master key.
    maintenanceKey: MAINTENANCE_KEY,
    serverURL: SERVER_URL,
    allowClientClassCreation: false,
    // Required for transactions: without it a save() in cloud code becomes an
    // internal HTTP request that lands in a fresh async context and writes
    // OUTSIDE the transaction, with no error.
    directAccess: true,
    schema: createSchemaConfig({adminRole: 'Editor'}),
  });

  await parseServer.start();

  const app = express();

  // 3. Middleware, in this order.
  app.use(removeResultMiddleware);                    // unwrap Parse's {result:…}
  app.use(MOUNT_PATH, validateEntityRoutes);          // /api/notes/x → cloud fn
  app.use(conditionalJsonMiddleware);                 // JSON body parsing
  app.use(MOUNT_PATH, restrictRoutes);                // block /classes, /schemas

  // 4. Mount Parse Server.
  app.use(MOUNT_PATH, parseServer.app);

  // 5. Registries, AFTER the mount.
  CloudFunctionRegistry.initialize();                 // also builds the routes
  TriggerRegistry.initialize();
  CronRegistry.initialize();

  // 6. Docs, and the admin console if it is installed.
  setupSwagger(app, {
    title: '{{PROJECT_NAME}} API',
    version: '1.0.0',
    basePath: MOUNT_PATH,
  });
  const dashboard = mountDashboard(app);

  const server = app.listen(PORT, async () => {
    // 7. Indexes and validators, after listen.
    await applyAllIndexes(parseServer);
    await applyMongoValidators(parseServer);

    let demoSessionToken: string | undefined;
    if (SEED_ON_BOOT) {
      demoSessionToken = await runSeed().catch(error => {
        console.warn('');
        console.warn('  Seeding failed, so the API has no roles or users yet.');
        console.warn(`  ${error?.message ?? error}`);
        console.warn('  Fix the cause and run:  npm run seed');
        console.warn('');
        return undefined;
      });
    }

    printBanner({dashboard, demoSessionToken});
  });

  return server;
}

main().catch(error => {
  if (String(error?.message ?? error).match(/ECONNREFUSED|connect|topology|timed out/i)) {
    console.error('');
    console.error(`  Cannot reach MongoDB at ${DATABASE_URI}`);
    console.error('');
    console.error('  Start one with:   docker compose up -d');
    console.error('  Or use Atlas:     set DATABASE_URI in .env');
    console.error('');
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
