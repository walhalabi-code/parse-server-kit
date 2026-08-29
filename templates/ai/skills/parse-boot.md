---
name: parse-boot
description: Use when changing src/app.ts or anything about how this project starts — boot order, configureKit, middleware, registries, indexes, MongoDB validators, Swagger, seeding, or the Parse Dashboard. The boot sequence is load-bearing and reordering it fails silently.
---

# Boot

`src/app.ts` is a sequence, not a config file. **Every step depends on the one
before it, and getting the order wrong mostly fails silently** — an empty
schema, missing routes, indexes that vanish on restart.

Do not reorder it to tidy it up.

## The order

```ts
// 1. MODELS FIRST. @ParseClass calls Parse.Object.registerSubclass while the
//    decorator is evaluated, so importing a model is what registers it.
importFiles(join(__dirname, 'models'));
importFiles(join(__dirname, 'functions'));

// 2. Parse Server. The schema is built from the decorators just imported.
const parseServer = ParseServer({ ... });
await parseServer.start();

// 3. Middleware, in this order.
app.use(removeResultMiddleware);            // unwrap Parse's {result: …}
app.use(MOUNT_PATH, validateEntityRoutes);  // /api/notes/x → cloud function
app.use(conditionalJsonMiddleware);         // JSON body parsing
app.use(MOUNT_PATH, restrictRoutes);        // block /classes, /schemas, /batch

// 4. Mount.
app.use(MOUNT_PATH, parseServer.app);

// 5. Registries, AFTER the mount.
CloudFunctionRegistry.initialize();         // also builds the routes
TriggerRegistry.initialize();
CronRegistry.initialize();

// 6. Docs.
setupSwagger(app, { title: '…', version: '1.0.0', basePath: MOUNT_PATH });

// 7. After listen().
await applyAllIndexes(parseServer);
await applyMongoValidators(parseServer);
```

## What each step gives you

| Step | Produces |
|---|---|
| `importFiles` | Every `@ParseClass` and `@Route` registered |
| `createSchemaConfig()` | The `schema` option, from the decorators |
| `CloudFunctionRegistry.initialize()` | Cloud functions **and** the REST routes |
| `applyAllIndexes` | Unique, B-tree, 2dsphere, TTL and compound indexes |
| `applyMongoValidators` | `$jsonSchema` validators, so the database enforces `required`, `min`, `enum` too |
| `setupSwagger` | `/api-docs` and `/api-docs/json`, with no annotations |

## `configureKit`

Tell the library what it should not have to guess. Values resolve when
**used**, so calling this after `dotenv` still works.

```ts
configureKit({
  mountPath: MOUNT_PATH,     // default: process.env.mountPath, then '/parse'
  masterKey: MASTER_KEY,     // default: process.env.masterKey
  adminRole: 'Admin',        // default: 'SuperAdmin'
  allowAuthRoutes: false,    // default: false — see below
});
```

**`masterKey` is worth setting explicitly.** `restrictRoutes` compares against
it; with nothing configured there is nothing to compare against, so a caller
with a perfectly valid master key is refused and nothing says why.

## `restrictRoutes` blocks Parse's auth endpoints

By design. `/login`, `POST /users`, `/requestPasswordReset` all return 403, and
the documented approach is to expose the ones you want as cloud functions —
which gives you somewhere to put rate limiting and lockout.

**If your client is a Parse SDK, this breaks login.** `Parse.User.logIn()` calls
`/login` directly and cannot be pointed at a cloud function:

```ts
configureKit({ allowAuthRoutes: true });
```

`GET /users` (querying the whole user table) and `PUT /users/<id>` stay blocked
either way — the method is part of the match. The 403 body names the setting, so
this is discoverable from the response.

## MUST

- **Models before `ParseServer`.** Otherwise the schema is empty.
- **Registries after the mount.** Otherwise routes are not built.
- **Indexes and validators after `listen()`.**
- **`.js` in `importFiles`** when running compiled output. Under ts-node pass
  `{extensions: ['.js', '.ts']}` — the default is `['.js']` only, and pointing it
  at `.ts` sources silently imports **nothing**.
- **`directAccess: true`** if you use transactions at all.
- **`keepUnknownIndexes`** left at its default `true` — `createSchemaConfig`
  sets it, because `applyAllIndexes` creates indexes out of band and
  parse-server's own default drops what it cannot account for.

## NEVER

- Never point `importFiles` at a tree holding both compiled and source copies —
  every class registers twice.
- Never call `configureKit` after the value is first used and expect it to apply
  retroactively.
- Never add a registration step for a new model or endpoint. `importFiles`
  finds them.

## Seeding

`src/seed.ts` splits reference data from sample data:

- `seed()` — roles, the hierarchy, the first admin. Safe in production.
- `seedSampleData()` — demo user and rows. Skipped when `NODE_ENV=production`.

Both idempotent. `npm run seed` runs it standalone against a running server;
at boot it runs unless `NODE_ENV=production`, overridable with `SEED_ON_BOOT`.

## Parse Dashboard

Not installed by default. `npm install parse-dashboard` and restart — `app.ts`
detects it and mounts `/dashboard`. It holds the **master key**, so it bypasses
every CLP and ACL: set `DASHBOARD_USER` and `DASHBOARD_PASS`. Unset in
production it refuses to mount.

## Reading the boot log

This is how you confirm the sequence worked:

```
Registered Parse class: Order            # models imported
Route: /orders/createOrder → createOrder # routes built
[Triggers] Registered beforeSave for: Order
[Cron] Registered: cleanupCarts
[Indexes] Created unique index: Product.sku
[Validators] Applied validator for: Order
```

An absent line is the fastest diagnosis available. No classes at all almost
always means `importFiles` found no files.
