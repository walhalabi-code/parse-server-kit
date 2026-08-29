# parse-server-kit — Complete Reference

Decorator-driven toolkit for Parse Server. **v3.0.0**

This document is the full API contract. Every signature here is taken from the
source, not paraphrased. If you are generating code against this library, read
[Silent failures](#silent-failures) first — most of the ways this library goes
wrong produce no error at all.

---

## Contents

- [Requirements](#requirements) · [Boot order](#boot-order)
- [Models](#models) — `@ParseClass`, `@ParseField`, `BaseModel`
- [Cloud functions](#cloud-functions) — `@CloudFunction`, `@Route`
- [Triggers](#triggers) · [Cron](#cron)
- [Transactions](#transactions) · [Optimistic locking](#optimistic-locking)
- [ACL](#acl) · [Middleware](#middleware) · [Indexes](#indexes)
- [Schema](#schema) · [Validation](#validation) · [Swagger](#swagger)
- [Utilities](#utilities) · [Constants](#constants) · [Types](#types)
- [Silent failures](#silent-failures) · [Version matrix](#version-matrix)

---

## Requirements

**`experimentalDecorators: true` is mandatory:**

```jsonc
{"compilerOptions": {"experimentalDecorators": true}}
```

This library uses **legacy** decorators. TypeScript 5 defaults to standard
(TC39) decorators, which are a different feature. Without the flag, every
decorator misbehaves. `emitDecoratorMetadata` is **not** needed — the library
reads no `design:type` metadata.

### Prefer `declare` for model fields

```ts
@ParseField({type: 'String'}) declare title: string;   // ✅ preferred
@ParseField({type: 'String'}) title!: string;          // works — repaired at runtime
```

`@ParseField` installs a getter and setter on the **prototype**, which read and
write Parse's attribute store. The field declaration exists only to give
TypeScript the type — the storage is Parse's, not the instance's.

Written as `title!: string`, TypeScript emits a real class field whenever
`useDefineForClassFields` is on (its default from `target: ES2022` upward).
That field is an own property set to `undefined`, and an own property
**shadows the prototype accessor**.

**Since 3.0.0 `@ParseClass` repairs that automatically** — it removes the
shadowing property on construction and routes any value it carried through the
accessor. Measured against the real library:

| target | style | `note.title` | `get('title')` | **what `save()` sends** |
|---|---|---|---|---|
| ES2022 | `title!: string` | `'hello'` | `'hello'` | `title` |
| ES2022 | `declare title` | `'hello'` | `'hello'` | `title` |
| ES2020 | either | `'hello'` | `'hello'` | `title` |

Before 3.0.0 the first row read `undefined` and sent **nothing** — a write
appeared to succeed while the value never reached Parse, with no error at any
point. If you are on an older version, this is the first thing to check.

`declare` is still the form to write. It emits no field at all, so there is
nothing to repair and nothing to pay for; it is correct under every `target`
and every `useDefineForClassFields` setting. The repair exists so that code
which does not use it cannot lose data, not as a licence to stop.

The repair is a **no-op where the problem does not arise** — below
`target: ES2022`, or with `declare`, no such property is ever created. The cost
is one boolean check per object, decided once per class.

You may still pin the flag explicitly, and `psk new` does:

```jsonc
{"compilerOptions": {"useDefineForClassFields": false}}
```

`psk new` generates models with `declare` **and** pins the flag.

**`Parse` is a global.** The library never imports `parse`; it reads
`global.Parse` the way cloud code sees it. Install `@types/parse` for the
type declarations. Do not declare your own global `Parse` namespace — it will
collide.

**Peers:** `parse >=5`, `express >=4`, `reflect-metadata >=0.1.13`.
**Optional:** `parse-server >=8.3`, `node-cron >=3`, `swagger-ui-express >=4`,
`@types/parse >=3`.

---

## Configuration

```ts
function configureKit(config: KitConfig): void;
function kitConfig(): Required<KitConfig>;
function resetKitConfig(): void;          // tests

interface KitConfig {
  mountPath?: string;              // default: process.env.mountPath ?? '/parse'
  masterKey?: string;              // default: process.env.masterKey ?? ''
  adminRole?: string;              // default: 'SuperAdmin'
  allowAuthRoutes?: boolean;       // default: false
  excludedPointerClasses?: string[]; // default: ['IMG', 'File']
}
```

Optional — every default reproduces the library's previous hardcoded
behaviour, so a project that never calls `configureKit` is unaffected.

```ts
configureKit({mountPath: '/api', adminRole: 'Owner'});
```

Values resolve when **used**, not at import, so calling this after `dotenv` has
populated the environment still works.

**`masterKey` is worth setting explicitly.** `restrictRoutes` compares against
it to let privileged callers past. With nothing configured there is nothing to
compare against, so a caller presenting a valid master key is refused — and
nothing says why.

**`allowAuthRoutes`** opens Parse's own auth endpoints through `restrictRoutes`:
`/login` (GET, POST), `/logout`, `POST /users` (signup), `GET /users/me`,
`GET /sessions/me`, `/requestPasswordReset`, `/verificationEmailRequest`. Off by
default, because the documented approach is to expose the ones you want as cloud
functions — which gives you somewhere to put rate limiting and lockout. Turn it
on when the client is a Parse SDK: `Parse.User.logIn()` calls `/login` directly
and cannot be pointed at a cloud function. `GET /users` (querying the whole user
table) and `PUT /users/<id>` stay blocked either way — the method is part of the
match.

---

## Boot order

Order is load-bearing. This sequence is the contract:

```ts
// 1. Models FIRST — @ParseClass calls Parse.Object.registerSubclass at
//    decorator-evaluation time, so Parse must already be global.
importFiles(join(__dirname, 'cloudCode/models'));
importFiles(join(__dirname, 'cloudCode/modules'));
import './cloudCode/cron';               // @Cron definitions

// 2. Parse Server
const parseServer = await initializeParseServer();

// 3. Middleware — this order matters
app.use(removeResultMiddleware);
app.use(cors());
app.use(process.env.mountPath, validateEntityRoutes);
app.use(conditionalJsonMiddleware);
app.use(process.env.mountPath, restrictRoutes);

// 4. Mount
app.use(process.env.mountPath, parseServer.app);

// 5. Registries — AFTER mount
CloudFunctionRegistry.initialize();   // also runs RouteRegistry + version check
TriggerRegistry.initialize();
CronRegistry.initialize();

// 6. Docs
setupSwagger(app, {title: 'My API', version: '1.0.0'});

// 7. After listen
await applyAllIndexes(parseServer);
await applyMongoValidators(parseServer);
```

---

## Models

### `@ParseClass(className, options?)`

Class decorator. Registers the Parse subclass, CLP, ACL template, compound
indexes; auto-registers the model with Swagger and flushes any pending triggers.

```ts
interface ParseClassOptions {
  clp?: classLevelPermissions;
  protectedFields?: {[role: string]: string[]};
  ACL?: ClassAclTemplate;
  description?: string;              // Swagger
  compoundIndexes?: CompoundIndex[];
}
```

```ts
@ParseClass('Product', {
  clp: {
    find:   {[roleKey(UserRoles.ADMIN)]: true},
    get:    {[roleKey(UserRoles.ADMIN)]: true},
    create: {[roleKey(UserRoles.ADMIN)]: true},
    update: {[roleKey(UserRoles.ADMIN)]: true},
    delete: {[roleKey(UserRoles.ADMIN)]: true},
    count:  {[roleKey(UserRoles.ADMIN)]: true},
  },
  compoundIndexes: [{fields: ['status', 'createdAt'], unique: false}],
})
export default class Product extends BaseModel { ... }
```

A `Parse.Role` subclass is detected and **not** registered via
`registerSubclass` (Parse rejects that).

### `@ParseField(options)`

Property decorator. Defines a getter/setter on the prototype mapping to
`Parse.Object.get/set`, so `product.name` **is** the supported API — not
`product.get('name')`.

```ts
interface ParseFieldOptions {
  type: 'String' | 'Number' | 'Boolean' | 'Date' | 'Object' | 'Array'
      | 'GeoPoint' | 'File' | 'Bytes' | 'Polygon' | 'Pointer' | 'Relation';
  required?: boolean;
  targetClass?: string;      // REQUIRED for Pointer / Relation
  description?: string;      // Swagger
  indexName?: string;        // override generated index name
  min?: number; max?: number;              // Number only
  minLength?: number; maxLength?: number;  // String only
  enum?: string[];           // String only
  pattern?: string;          // String only, valid RegExp
  geo?: boolean;             // GeoPoint only → 2dsphere index
  ttlSeconds?: number;       // Date only → TTL index
  index?: boolean | 1 | -1;  // mutually exclusive with `unique`
  unique?: boolean;          // mutually exclusive with `index`
}
```

**Options are validated at import time** and throw immediately — a Pointer with
no `targetClass`, `min` on a String, an invalid regex, `geo` combined with
`index`, a negative `ttlSeconds`. Failures happen at boot, not in production.

`index` and `unique` are mutually exclusive in the type system. `geo` and
`ttlSeconds` cannot be combined with either.

### `BaseModel`

```ts
class BaseModel extends Parse.Object {
  protected static EXCLUDED_POINTER_CLASSES: string[];  // default ['IMG','File']
  static pointer<T>(id: string): InstanceType<T>;
  static fromParams<T>(params: any): InstanceType<T>;
}
```

- **`Model.pointer(id)`** — a reference by id, no fetch.
- **`Model.fromParams(req.params)`** — builds an instance from request params,
  reading `@ParseField` metadata to convert Pointers, Arrays-of-Pointers, Dates
  and GeoPoints. Use this in create/update rather than manual `set()`.
  - Pointer fields whose `targetClass` is in `EXCLUDED_POINTER_CLASSES` are
    **skipped** (`IMG`, `File` need their own handling).
  - An Array field converts to pointers **only if `targetClass` is set**.
  - A Pointer given `null` or `{}` is set to `null` (explicit clear).

`Parse.Query` returns `Parse.Object`, not your typed class — cast the result
(`row as Product`) or direct property access is unavailable.

---

## Cloud functions

### `@CloudFunction(config)`

Static-method decorator. Registers the function and wraps it with the auth and
role checks.

```ts
interface RouteConfig {
  methods: HttpMethod[];                      // 'GET'|'POST'|'PUT'|'DELETE'|'PATCH'
  requiresAuth?: boolean;                     // enforced; master key passes
  rateLimit?: {windowMs: number; max: number}; // per process, both entry paths
  // note: `methods` applies to the entity route only, not /functions
  validation?: Parse.Cloud.Validator;
  description?: string;
  requireRoles?: string[];
  requireAllRoles?: boolean;                  // default false = ANY role
  customErrorMessage?: string;
  swagger?: {summary?; description?; tags?; deprecated?; responses?};
}
```

`requiresAuth` and `requireRoles` are both enforced by the wrapper before your
body runs: no user → `OBJECT_NOT_FOUND 'Authentication required'`; wrong roles →
`OPERATION_FORBIDDEN`. `requireAllRoles: true` demands every listed role. A call
carrying the master key passes `requiresAuth` — the system is not an anonymous
caller.

`validation: {requireUser: true}` does the same job as `requiresAuth` through
Parse Server's own validator. Either is fine; both together is harmless.

`rateLimit` is enforced on **both** ways in — the entity route and a direct
`/functions/{name}` call. It is per process, so N instances means N times the
limit.

The declared `methods` apply to the **entity route only**. `/functions/{name}`
is Parse's own protocol endpoint and every SDK's `Parse.Cloud.run` POSTs to it,
so enforcing `methods` there would make any GET-declared function unreachable
from a Parse client.

> Before 3.0.0 `requiresAuth` was read only by the OpenAPI renderer, and
> `rateLimit`/`methods` were checked only on the entity route. Code written
> against those versions may be relying on protections that were not actually
> running.

**GET params arrive as strings** — `validateEntityRoutes` merges the query
string into the body. Declare them `{type: String}` and convert:

```ts
const limit = Number(req.params.limit) || 10;
const active = req.params.isActive === 'true';
```

### `@ProtectedCloudFunction(config?)`

`@CloudFunction` with `methods: ['POST']` and `validation: {requireUser: true}`
pre-applied; your config overrides.

### `@Route(ModelOrString)`

Class decorator mapping methods to REST routes. Captures **both** prototype and
static method names.

```ts
@Route(Product)         // → /api/products/*    (kebab-plural of the JS class name)
@Route('menu-items')    // → /api/menu-items/*
```

The route is `/{prefix}/{methodName}` — **the method name is the route**, matched
against the class's real method list, so there is no string parsing and no
collision between `getProduct` and `getProductCategory`.

```
createProduct → POST /api/products/createProduct
listProducts  → GET  /api/products/listProducts
```

---

## Triggers

All are static-method decorators taking `{description?, validation?}`.

> **Triggers only register if the class also has `@ParseClass`.** They park in
> metadata until `@ParseClass` names the class and flushes them. On a plain
> class they are silently never registered.

| Decorator | Registers as |
|---|---|
| `@BeforeSave` `@AfterSave` | `Parse.Cloud.beforeSave(className, …)` |
| `@BeforeDelete` `@AfterDelete` | `beforeDelete` / `afterDelete` |
| `@BeforeFind` `@AfterFind` | `beforeFind` / `afterFind` |
| `@BeforeLogin` `@AfterLogin` `@AfterLogout` | auth triggers (no className) |
| `@BeforePasswordResetRequest` | `beforePasswordResetRequest` — parse-server 8.5+ |
| `@BeforeSaveFile` `@AfterSaveFile` | `beforeSave(Parse.File, …)` |
| `@BeforeDeleteFile` `@AfterDeleteFile` | `beforeDelete(Parse.File, …)` |
| `@BeforeFindFile` `@AfterFindFile` | `beforeFind(Parse.File, …)` — 8.1+ |
| `@BeforeSaveConfig` `@AfterSaveConfig` | `beforeSave(Parse.Config, …)` — 7.3+ |
| `@BeforeConnect` `@BeforeSubscribe` `@AfterEvent` | LiveQuery (`afterEvent` → `afterLiveQueryEvent`) |

File and Config triggers pass the **class itself**, not a name. parse-server
removed the old `beforeSaveFile()` style methods; this library handles the
translation.

One trigger per `className:type` — a second registration warns and overwrites.

```ts
@ParseClass('Product', {...})
export default class Product extends BaseModel {
  @BeforeSave()
  static async onBeforeSave(req: Parse.Cloud.BeforeSaveRequest<Product>) {
    if (!req.object.get('name')) throw new Parse.Error(142, 'Name is required');
  }
}
```

---

## Cron

```ts
interface CronConfig {
  schedule: string;      // cron expression, validated at initialize()
  description?: string;
  enabled?: boolean;     // default true
  timezone?: string;     // default 'UTC'
}
```

```ts
class Jobs {
  @Cron({schedule: CronSchedule.DAILY_MIDNIGHT, description: 'Cleanup'})
  static async cleanup() { ... }
}
```

`CronSchedule`: `EVERY_MINUTE`, `EVERY_5_MINUTES`, `EVERY_10_MINUTES`,
`EVERY_15_MINUTES`, `EVERY_30_MINUTES`, `EVERY_HOUR`, `EVERY_2_HOURS`,
`EVERY_6_HOURS`, `EVERY_12_HOURS`, `DAILY_MIDNIGHT`, `DAILY_NOON`,
`WEEKLY_SUNDAY`, `WEEKLY_MONDAY`, `MONTHLY_FIRST`, `YEARLY`.

`CronRegistry`: `initialize()`, `getJobs()`, `getJob(name)`, `stopJob(name)`,
`startJob(name)`, `stopAll()`, `runNow(name)`. Without `node-cron` installed,
`initialize()` warns and skips — jobs never run.

---

## Transactions

MongoDB only. Requires a **replica set** and parse-server `directAccess: true`.

```ts
// parse-server 9 refuses an explicit databaseAdapter without an explicit
// filesAdapter. GridFS is the MongoDB default, so this changes nothing but the
// error you would otherwise get.
const {GridFSBucketAdapter} =
  require('parse-server/lib/Adapters/Files/GridFSBucketAdapter');

const options = {
  databaseAdapter: createVersionedMongoAdapter({
    uri: process.env.DATABASE_URI, collectionPrefix: '', mongoOptions: {},
  }),
  filesAdapter: new GridFSBucketAdapter(process.env.DATABASE_URI),
  directAccess: true,   // REQUIRED — see below
};

// Cast, because parse-server's types and runtime disagree: ParseServerOptions
// marks `databaseURI` REQUIRED and does not special-case `databaseAdapter`, but
// passing both throws "You cannot specify both a databaseAdapter and a
// databaseURI/databaseOptions/collectionPrefix." Nothing satisfies both.
const parseServer = ParseServer(options as any);
```

```ts
function Transactional(): MethodDecorator;
function withTransaction<T>(body: () => Promise<T>): Promise<T>;
function inTransaction(): boolean;
function currentSession(): unknown;
const CONFLICT = 5001;
const CONFLICT_MESSAGE: string;
```

### ⚠️ Decorator order

```ts
@CloudFunction({...})   // MUST be above — sees the wrapped method
@Transactional()        // MUST be below — does the wrapping
static async submitJob(req) { ... }
```

Decorators apply bottom-up and `@CloudFunction` captures the method when
applied. Reversed, the registry keeps the **unwrapped** method and the
transaction **never opens** — no error, no log.

### Semantics

- Every `save()` / `destroy()` / query inside the body joins automatically
  (`AsyncLocalStorage` follows the call chain). No session threading.
- **Nested calls join** the outer transaction; the outermost caller commits.
- **The body may re-run** (up to 3 attempts) on a transient conflict, so it must
  be safe to repeat. After 3 losses the caller gets `CONFLICT`.
- Each concurrent request gets its **own** session — unlike Parse Server's
  built-in transaction, which is `DatabaseController`-global.
- Never joined: `_SCHEMA`, `_Idempotency`, `_Hooks`, `_JobStatus`,
  `_GlobalConfig` — schema creation must survive a rollback.
- Unfiltered `count()` reads **outside** the transaction (MongoDB refuses
  `count` inside one).

Without `directAccess`, a `save()` in cloud code becomes an internal HTTP
request landing in a fresh async context, and writes **outside** the
transaction. That failure has no symptom.

---

## Optimistic locking

```ts
@ParseClass('Job')
class Job extends BaseModel {
  @ParseVersionField()   // declares the Number field itself — no @ParseField
  version!: number;
}
```

That is the entire feature. No endpoint reads or writes the field:

- every object **read** carries the version it was read at; every `save()` /
  `saveAll()` asserts it automatically;
- the adapter moves the assertion into the write's **filter** and `$inc`s the
  field, so the next reader gets a fresh number;
- a lost race is refused with `CONFLICT` (5001); a genuinely missing row still
  reads as missing;
- creates get version `1` from the adapter — callers never supply one;
- an object built from a bare id (never read) has nothing to assert and is
  **not protected**.

```ts
try {
  await job.save(null, {useMasterKey: true});
} catch (error) {
  if (error instanceof Parse.Error && error.code === CONFLICT) {
    // Reload, re-apply, retry — or surface CONFLICT_MESSAGE, already
    // written for the end user.
  }
  throw error;
}
```

`VERSION_CONFLICT` === `CONFLICT` — a lost lock and a lost transaction race are
the same event to the person on the screen.

`VersionRegistry`: `fieldFor(className)`, `isVersioned(className)`,
`classNames()`, `adapterIsInstalled()`, `verify()`.

---

## ACL

```ts
function implementACL(
  params: {
    publicRead?: boolean;
    publicWrite?: boolean;
    roleRules?: {role: string; read?: boolean; write?: boolean}[];
    excludedRoles?: string[];
    owner?: {user?: string | any; read?: boolean; write?: boolean}[];
  },
  existingACL?: Parse.ACL
): Parse.ACL;
```

**It takes one params object and RETURNS an ACL.** It does not take the object
as an argument.

```ts
// CORRECT
product.setACL(implementACL({
  roleRules: [
    {role: UserRoles.ADMIN, read: true, write: true},
    {role: UserRoles.EMPLOYEE, read: true},
  ],
  publicRead: status === 'active',
  owner: [{user: userId, read: true, write: true}],
}));

// WRONG — no such signature, will not compile
implementACL(product, {readRoles: [...], writeRoles: [...]});
```

```ts
function syncImageAcl(parent: Parse.Object, fields: string[], acl?: Parse.ACL): void;
function cloneAcl(acl: Parse.ACL): Parse.ACL;
```

`syncImageAcl` copies the parent's ACL onto nested image pointers (single or
array) so they follow the parent's visibility. Call it **after** setting the
parent's final ACL and **before** saving. For status-derived visibility set in a
`beforeSave` trigger, pass `publicRead` into `implementACL` at the call site —
`syncImageAcl` runs before the trigger.

---

## Middleware

| Export | Purpose |
|---|---|
| `validateEntityRoutes` | Resolves `/api/{entity}/{action}` → cloud function; enforces the declared HTTP method (405); applies `rateLimit`; merges GET query into body; rewrites to `/functions/{name}` as POST |
| `restrictRoutes` | Blocks `/classes`, `/schemas`, `/batch`, **and Parse's auth endpoints**. Allows `/health`, `/serverInfo`, `/files`, registered prefixes, `/functions`. Master key bypasses. `configureKit({allowAuthRoutes: true})` opens `/login` and friends |
| `removeResultMiddleware` | Unwraps Parse's `{result: …}` response |
| `conditionalJsonMiddleware` | `express.json({limit:'10mb', type:['text/plain']})`, skipping `{mountPath}/files` |
| `validateFunctionRoutes` | Legacy `/functions/*` validation |
| `checkRateLimit(req,res,name,cfg)` | In-process token bucket; returns `false` after sending 429 |

**Master key** is read from the `X-Parse-Master-Key` header (preferred) or the
request body (deprecated, warns once). Rate limiting is **per process** — no
enforcement across instances.

A 403 from `restrictRoutes` carries both `message` (unchanged: `Route not
allowed`) and `detail`, which names what is allowed and, for an auth route, the
`allowAuthRoutes` setting. `Parse.User.logIn()` failing with a bare 403 was this
library's most confusing behaviour; the response now explains itself.

---

## Indexes

```ts
function applyAllIndexes(parseServerInstance?: any): Promise<void>;
const applyUniqueIndexes = applyAllIndexes;   // permanent alias
function getUniqueIndexes(): UniqueIndexInfo[];
function getCompoundIndexes(): CompoundIndexInfo[];
function getFieldIndexes(): FieldIndexInfo[];
```

Call after `listen()`. Creates, from decorator metadata:

| Source | Index |
|---|---|
| `@ParseField({unique: true})` | unique (drops a conflicting non-unique index first) |
| `@ParseField({index: true \| 1 \| -1})` | B-tree asc/desc |
| `@ParseField({geo: true})` on GeoPoint | 2dsphere |
| `@ParseField({ttlSeconds: N})` on Date | TTL |
| `@ParseClass({compoundIndexes})` | compound |

```ts
interface CompoundIndex {
  fields: string[];
  unique?: boolean;
  name?: string;
  sparse?: boolean;
  partialFilterNulls?: boolean;                       // only index docs where all fields exist
  fieldTypes?: Record<string, 1|-1|'text'|'2dsphere'|'hashed'>;
  options?: Record<string, unknown>;                  // e.g. default_language
}
```

Existing indexes (codes 85/86) are reported, not treated as errors. If the
adapter can't be reached it prints the equivalent `db.x.createIndex(...)`
commands. MongoDB allows only **one text index per collection**.

---

## Schema

```ts
function createSchemaConfig(options?: SchemaConfigOptions): {...};

interface SchemaConfigOptions {
  adminRole?: string;               // default 'SuperAdmin'
  lockSchemas?: boolean;            // default false
  strict?: boolean;                 // default true
  recreateModifiedFields?: boolean; // default false — DANGEROUS
  deleteExtraFields?: boolean;      // default false — DANGEROUS
  keepUnknownIndexes?: boolean;     // default TRUE — parse-server 8.3+
}
```

Builds the `schema` option from every registered `@ParseClass`, plus a `_Role`
definition locked to `adminRole`.

`keepUnknownIndexes` defaults to **true** because `applyAllIndexes` creates
indexes out-of-band; parse-server's default (`false`) drops indexes it cannot
account for during schema migration. **Requires parse-server 8.3+** — it refuses
to start on an unrecognised option.

---

## Validation

```ts
function validateObject(object: Parse.Object): {valid: boolean; errors: {field, message, value?}[]};
function validateOrThrow(object: Parse.Object): void;   // throws Parse.Error VALIDATION_ERROR
function getValidators(): {className, validator}[];
function applyMongoValidators(parseServerInstance?: any): Promise<void>;
```

Checks `required`, `min`/`max`, `minLength`/`maxLength`, `enum`, `pattern` from
`@ParseField`. `validateOrThrow` is intended for `@BeforeSave`.
`applyMongoValidators` pushes the same constraints into MongoDB `$jsonSchema`
validators (`validationLevel: 'moderate'`, `validationAction: 'error'`), so the
database enforces them even for writes that bypass your code.

---

## Swagger

```ts
function setupSwagger(app: Express, config: SwaggerConfig, path?: string): void;  // default '/api-docs'
function generateSwaggerSpec(config: SwaggerConfig): object;
function getSwaggerJson(config: SwaggerConfig): string;

interface SwaggerConfig {
  title: string; version: string;
  description?: string; basePath?: string; host?: string; schemes?: string[];
}
```

Models and endpoints are registered automatically from `@ParseClass` /
`@CloudFunction` — no annotation needed. Endpoints document their real `@Route`
path. **GET/HEAD emit query `parameters`; everything else emits a JSON
`requestBody`** (a browser cannot send a GET body). Security schemes derive from
`requireUser` / `requireMaster` / `requireRoles`.

The spec is always served at `{path}/json`. Without `swagger-ui-express`
installed, the browser UI is skipped with a warning; the spec still serves.

---

## Utilities

```ts
function catchError<T>(p: Promise<T>): Promise<[undefined, T] | [Error]>;
function getUserRoles(user: Parse.User): Promise<string[]>;
function getUsersRoles(users: Parse.User[]): Promise<Map<string, string[]>>;
function importFiles(dir: string, options?: {extensions?: string[]; verbose?: boolean}): void;
function generateRandomPassword(length?, includeNumbers?, includeSymbols?): string;
function generateRandomString(length?: number): string;
function generateRandomInteger(length: number): string;
function sleep(ms: number): Promise<unknown>;
function formatCount(num: any, locale?: string): string;   // compact notation
```

**`catchError` is the error convention** — use it for all async work rather than
`try/catch` around `await`:

```ts
const [err, saved] = await catchError(product.save(null, {sessionToken}));
if (err) throw err;
```

**`importFiles` defaults to `.js` only.** Under ts-node/tsx pass
`{extensions: ['.js', '.ts']}` or nothing is imported at all. Never point it at
a tree holding both compiled and source copies — every class registers twice.

`getUsersRoles` costs one query per **role** (capped at 100), not per user.

### Role cache (opt-in, off by default)

```ts
function configureRoleCache(config: {ttlMs: number; maxUsers?: number} | false): void;
function invalidateRoles(userId?: string): void;   // no arg = everyone
function roleCacheEnabled(): boolean;
function roleCacheStats(): {enabled: boolean; size: number; ttlMs: number | null};
```

`@CloudFunction({requireRoles})` and `getUserRoles()` each cost a database
round-trip per call. Role membership rarely changes, so it caches well — but a
**revoked role keeps working until the entry expires**, which is why nothing
happens until you opt in:

```ts
configureRoleCache({ttlMs: 30_000});                    // global
@CloudFunction({requireRoles: [...], roleCacheMs: 0})   // this endpoint never caches
```

Call `invalidateRoles(userId)` wherever you grant or revoke, and the TTL becomes
a backstop for changes made outside your code rather than the primary control.
`maxUsers` (default 10000) bounds memory; the oldest entry is evicted past it.
There is no timer — entries expire on read.

---

## Constants

```ts
function roleKey<R extends string>(role: R): `role:${R}`;
type RoleString<R extends string = string> = `role:${R}`;
const MAX_QUERY_LIMIT = 10000;

/** @deprecated define your own */
enum UserRoles {ADMIN = 'SuperAdmin', EMPLOYEE = 'Employee'}
```

**Define your own roles.** `roleKey` takes any string and returns the exact
literal type, so it works with your enum, a union, or a plain string:

```ts
export enum Roles {OWNER = 'Owner', MEMBER = 'Member'}

@ParseClass('Product', {clp: {find: {[roleKey(Roles.OWNER)]: true}}})
```

The built-in `UserRoles` is two example values from one project and is
deprecated — it cannot represent any real application's roles. `AuthRole`,
`MultiLangs` and `Filter` in `types/common` are deprecated for the same reason.

Use `roleKey(...)` for CLP/ACL keys — never hardcode `'role:Owner'`.

---

## Types

`ClassNameType`, `CLPParamsOption`, `classLevelPermissions`, `ClassAclTemplate`,
`AclTemplatePermissions`, `ProtectedFields`, `CompoundIndex`, `IndexFieldType`,
`Fields`, `Indexes`, `SchemaDefinition`, `HttpMethod`, `RouteConfig`,
`CloudFunctionMetadata`, `SwaggerDocConfig`, `TriggerType`, `TriggerMetadata`,
`TriggerConfig`, `CronConfig`, `CronJobMetadata`, `RoleString`,
`ParseClassOptions`, `ParseFieldOptions`, `AllowedFieldType`,
`SwaggerModelSchema`, `SwaggerPropertySchema`, `SwaggerFunctionSchema`,
`SchemaConfigOptions`, `TransactionalAdapter`, `VersionedMongoAdapter`,
`MongoAdapterConstructor`.

```ts
interface AuthRole  {id: string; name: string}
interface MultiLangs {ar?: string; en?: string}
interface Filter    {key: string; value: string|number|string[];
                     type: 'string'|'min'|'max'|'array'|'text'|'dropdown'}
```

**Registration hooks** (for custom integrations):
`onClassRegistered`, `onFieldRegistered`, `onFunctionRegistered`.
Also exported: `getSchemaDefinition(target)`, `classNames`.

---

## Silent failures

Every item here produces **no error**. This is the list to check when something
"doesn't work" but nothing is logged.

| Symptom | Cause |
|---|---|
| Decorators do nothing / odd behaviour | `experimentalDecorators` not set — TS 5 defaults to standard decorators |
| **Fields read `undefined`, or a write never reaches the database** | Repaired automatically since 3.0.0 — but only for `@ParseField` properties. A field declared `title!: string` instead of `declare title: string`. At `target: ES2022+` the emitted class field shadows `@ParseField`'s prototype accessor — reads return `undefined`, and writes land on the instance so `save()` sends nothing |
| Master key rejected despite being correct | Neither `configureKit({masterKey})` nor `process.env.masterKey` set, so `restrictRoutes` has nothing to compare against and the bypass never fires |
| Endpoint reachable without a session, despite `requiresAuth: true` | Fixed in 3.0.0. Before that the flag was read only by the OpenAPI renderer, so the endpoint was open while the docs drew a padlock on it |
| Rate limit never fires | Fixed in 3.0.0. It was applied only on the entity route, so calling `/functions/{name}` directly skipped it. (The declared `methods` still apply to the entity route only — `Parse.Cloud.run` always POSTs.) |
| Transaction never opens | `@Transactional()` placed **above** `@CloudFunction` instead of below |
| Writes land outside the transaction | parse-server `directAccess` not `true` |
| No models, empty schema, no routes | `importFiles` ran over `.ts` sources with the default `['.js']` |
| Every class registered twice | `importFiles` pointed at a tree with both compiled and source copies |
| Trigger never fires | Declared on a class without `@ParseClass` — pending triggers are never flushed |
| Unique indexes vanish after restart | `keepUnknownIndexes` false, or parse-server < 8.3 |
| Pointer field ignored by `fromParams` | `targetClass` missing, or it is `IMG`/`File` (excluded by design) |
| Array of pointers stays raw | Array field has no `targetClass` |
| Direct property access unavailable | Query result not cast to the typed model |
| Cron jobs never run | `node-cron` not installed — `initialize()` warns and skips |
| Object not protected by version field | Built from a bare id, never read, so there is nothing to assert |

Three of these now **do** log as of v2.8.0: `@ParseVersionField` with no adapter
(or on Postgres), and a Parse SDK where `_getSaveJSON` has moved. Check the boot
output for `[Versioning]`.

---

## Version matrix

| | Requirement |
|---|---|
| Node | ≥ 18 for this package; **≥ 20.19** with parse-server 9 |
| parse-server | ≥ 8.3 (optional peer) — `keepUnknownIndexes`, adapter internals |
| MongoDB | ≥ 7.0.16 for parse-server 9; **replica set** for transactions |
| Parse SDK | ≥ 5; verified on 5.3.0 and 8.6.0 |
| TypeScript | any, with `experimentalDecorators: true` |

**Transactions and `@ParseVersionField` are MongoDB-only.** On Postgres the
version field is declared but never enforced.
