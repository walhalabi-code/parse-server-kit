# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **On the version number.** This is the first public release and it starts at
> 3.0.0, not 1.0.0. The library had two major versions of private history
> before it was opened up, and continuing that sequence keeps the changelog
> below honest about what changed when.

---

## [3.0.0] — first public release

The library carried assumptions from the codebase it grew out of: a fixed
two-value roles enum, a pointer class called `IMG`, an environment variable
named `mountPath` read directly out of `process.env`. Each worked perfectly
for one project and made no sense for anyone else.

### Fixed
- **Field and trigger metadata leaked across an inheritance tree.**
  `Reflect.getMetadata` walks the prototype chain, so a subclass with no
  metadata of its own was handed the *parent's* object — which was then
  mutated in place. Every class in the tree ended up sharing one record:

  ```ts
  class Auditable extends BaseModel { @ParseField() declare createdBy }
  class Product   extends Auditable { @ParseField() declare name }
  class Order     extends Auditable { @ParseField() declare total }
  // Product gained `total`, Order gained `name`, Auditable gained both
  ```

  The result was wrong schemas, `fromParams` converting fields the model does
  not have, `validateOrThrow` demanding foreign required fields, and
  `applyAllIndexes` indexing columns that do not exist — none of it reported.
  Both `parse:fields` and `parse:pendingTriggers` now copy on first write.

- **`requiresAuth` enforced nothing.** It was read only by the OpenAPI
  renderer, so an endpoint declaring it was reachable with no session *while
  the docs drew a padlock on it*. It is now checked in the handler wrapper
  before the body runs; a call carrying the master key still passes.
  **Behaviour change** — endpoints that were accidentally open are now closed.

- **The two auth gates disagreed about the master key.** `requiresAuth` let it
  through while `requireRoles` answered `Authentication required` (code 101) to
  the same caller — so one request passed one gate and failed the other, and a
  cron job or migration calling a role-gated function was refused with a
  message describing the most privileged principal in the system as
  unauthenticated. `requireRoles` now exempts it too.

  It concedes nothing: a caller holding the master key is already past
  `restrictRoutes`, already bypasses every CLP and ACL by Parse's own design,
  and could grant itself the role and call again.

- **`rateLimit` could be skipped.** It was applied only in
  `validateEntityRoutes`, which returns early for anything that is not a
  registered entity prefix — so asking for `/functions/{name}` directly
  bypassed it. `restrictRoutes` now applies it on that path too.

  The declared `methods` deliberately do **not** follow: `/functions/{name}` is
  Parse's own protocol endpoint and every SDK's `Parse.Cloud.run` POSTs to it,
  so enforcing them there would make any GET-declared function unreachable from
  a Parse client. Role checks and `requiresAuth` were never affected either way.
  **Behaviour change.**

- **Declaring a field `unique` dropped compound indexes containing it.** The
  conflict check matched any non-unique index *containing* the field, so
  `unique: true` on `status` alongside a compound index on
  `['status', 'createdAt']` dropped the compound one on every boot. An index
  created outside this library was dropped for good. Only single-field indexes
  are treated as conflicts now.

- **The master key was compared with `===`**, which short-circuits on the first
  differing character and leaks the key a character at a time under timing
  analysis. Now `crypto.timingSafeEqual`.

- **`restrictRoutes` matched its allowlist by prefix**, so `/functionsX`
  passed as `/functions`, `/healthz-internal` as `/health`, and a registered
  `@Route('user')` prefix opened every path beginning `/user` — Parse's own
  `/users` table endpoints included, which this library documents as blocked.
  All three now match by whole path segment (`isUnderPrefix`), so a prefix
  covers itself and what is under it and nothing else.

- **Malformed JSON mentioning a master key both answered 400 and threw**,
  leaving Express reporting "Cannot set headers after they are sent" on top of
  the real error. It throws only. The thrown error carries `status: 400`,
  because body-parser wraps a `verify` failure as `createError(403, err)` —
  without it a malformed body would answer 403 rather than the 400 it always
  did.

- **`readCachedRoles` returned the cache's own array.** A caller sorting or
  filtering it in place rewrote what every later permission check saw.

- **`fromParams` wrote `className` into the caller's `req.params`.** It works on
  a copy, so a retried transaction no longer sees an input the first attempt
  altered.

- **`validateFunctionRoutes` 404'd everything** unless mounted at
  `{mountPath}/functions`, because it read the path segment blindly. It now
  works at either mount point. (Legacy — new projects do not need it.)

- **A model field could silently never reach the database.** `@ParseField`
  installs a getter/setter on the prototype; a field written `title!: string`
  compiles, at `target: ES2022` and above, to an own property that shadows it.
  Reads returned `undefined`, and — worse — writes landed on the instance
  rather than Parse, so `save()` sent nothing and raised no error.

  `@ParseClass` now removes such a field and routes its value through the
  accessor, so the problem cannot occur however fields are declared or the
  compiler is configured. Verified with `useDefineForClassFields` deliberately
  forced on.

  This is a no-op below `target: ES2022`, where no such property is ever
  created — existing projects are unaffected, and the cost is one boolean
  check per object.
- **`restrictRoutes` read `process.env.masterKey` directly.** With the variable
  unset the master-key bypass never fired, and a caller presenting a valid
  master key was refused — silently. It now reads
  `configureKit({masterKey})`, falling back to that variable.

### Added
- **A project generator.** `npx parse-server-kit new my-api` writes a runnable
  project: correct boot order, `experimentalDecorators` already set, models
  declared with `declare`, a MongoDB replica set via `docker-compose.yml` so
  transactions work, and a seeded user so the first write does not answer 400.
  Installed globally the command is `psk`.

  The CLI has **no dependencies** — this package still installs nothing.
- **`configureKit()`** — `mountPath`, `masterKey`, `adminRole` and
  `excludedPointerClasses` are now settings rather than constants. Every
  default reproduces the previous behaviour, and values resolve when used
  rather than at import, so calling it after `dotenv` still works.

### Changed
- **`roleKey()` accepts any role.** It was typed to a built-in enum of
  `SuperAdmin` and `Employee`, so no real application's roles could type-check
  against it. It is now generic and returns the exact literal type:
  ```ts
  enum Roles {OWNER = 'Owner'}
  roleKey(Roles.OWNER)   // 'role:Owner'
  ```
- `RoleString` is generic, defaulting to any role.
- With no mount path configured or in the environment, the default is now
  `/parse` — Parse Server's own default. It was previously the string
  `"undefined"`, which is not a path.

### Deprecated
Kept exported, to be removed in the next major:
- **`UserRoles`** — two example role names from one project. Declare your own.
- **`AuthRole`**, **`MultiLangs`**, **`Filter`** — application types that
  describe nothing Parse Server or this library does. `MultiLangs` in
  particular hardcoded Arabic and English.

## [2.9.0]

### Added
- **Opt-in role cache.** `@CloudFunction({requireRoles})` and `getUserRoles()`
  each cost a database round-trip per call. `configureRoleCache({ttlMs})` makes
  that cacheable, with `invalidateRoles(userId)` for grant/revoke and
  `roleCacheMs: 0` to opt a sensitive endpoint out.
  **Off by default** — caching membership means a revoked role keeps working
  until the entry expires, which is a security trade that belongs to the
  deployment, not the library.

### Changed
- The Swagger spec is generated once and cached against a registry revision
  counter, instead of being rebuilt from every model and endpoint on each hit
  of `{path}/json`. Late registration still invalidates it.

## [2.8.2]

### Fixed
- **Every request body was JSON-parsed twice.** `extractMasterKey` is
  body-parser's `verify` callback, so it receives the raw buffer and
  body-parser then parses that same buffer itself. It now scans the bytes
  first and parses only a body that actually mentions a master key.
  Measured: 2× faster at 1 kB, 7× at 10 kB, 11× at 127 kB.
- The JSON parser is built once instead of on every request.

### Added
- First tests for the middleware layer.

## [2.8.1]

### Fixed
- **The documented route format was wrong.** The README described
  `createProduct` mapping to `/api/products/create`; it has been
  `/api/products/createProduct` since 2.3.0. Anyone building a client from the
  docs was calling URLs that 404.

### Added
- `CLAUDE.md` — the complete API surface with signatures taken from source,
  the boot-ordering contract, and a table of every way this library fails
  without raising an error. Shipped inside the package.

## [2.8.0]

### Fixed
- **`swagger-ui-express` was mandatory while documented as optional.** The
  package root re-exports `setupSwagger`, so importing anything at all threw
  `MODULE_NOT_FOUND` without it. Now required lazily.
- **Importing the package held the event loop open.** The rate-limit cleanup
  timer was never `unref`'d, so seed scripts, migrations and Jest runs hung
  instead of exiting.
- **All three `peerDependenciesMeta` entries were orphaned** — `node-cron`,
  `swagger-ui-express` and `parse-server` were marked optional but never
  declared as peers, so npm ignored them and validated nothing.
- **File triggers were dead on parse-server 9.** `Parse.Cloud.beforeSaveFile`
  and its three siblings were removed upstream in favour of passing the class
  itself to `beforeSave`. `@BeforeSaveFile` threw `TypeError` at
  `TriggerRegistry.initialize()` and took the boot down with it.

### Added
- `@BeforePasswordResetRequest`, `@BeforeFindFile` / `@AfterFindFile`,
  `@BeforeSaveConfig` / `@AfterSaveConfig`.
- `importFiles(path, {extensions})` — defaults to `.js`, so ts-node users can
  opt in rather than silently importing nothing.
- `createSchemaConfig({keepUnknownIndexes})`, defaulting to `true`.
  parse-server drops manually-created indexes during schema migration, which
  is exactly what `applyAllIndexes` produces.
- Master key accepted via the `X-Parse-Master-Key` header. The body channel
  still works and warns once.
- Four silent failures now announce themselves at boot: `@ParseVersionField`
  declared with no adapter, on Postgres, or against a Parse SDK that moved
  `_getSaveJSON`.

### Changed
- `parse-server` peer floor is 8.3.0 — the first version that recognises
  `keepUnknownIndexes`. parse-server refuses to start on an unknown option.
- `engines.node` declared as `>= 18`.
- `experimentalDecorators: true` documented as mandatory. TypeScript 5
  defaults to standard decorators, which this package does not use.

## [2.7.0] — never published

### Added
- **Transactions.** `@Transactional()` / `withTransaction()`, carried on
  `AsyncLocalStorage` so every `save()`, `destroy()` and query inside the body
  joins automatically. Each concurrent request gets its own session, unlike
  Parse Server's built-in transaction, which is `DatabaseController`-global.
- **Optimistic locking.** `@ParseVersionField()` declares a version field and
  nothing else is required: the adapter moves the assertion into the write's
  filter and increments the field, so a stale save is refused with `CONFLICT`.
- `createVersionedMongoAdapter()` — one adapter powering both.

## [2.5.3]

### Fixed
- Swagger: GET/HEAD endpoints emit query `parameters` rather than a JSON
  `requestBody`. A browser cannot send a body on a GET.

## [2.4.0]

### Added
- `createSchemaConfig()` and `applyAllIndexes()` moved into the library.

## [2.3.1]

### Fixed
- `@Route` captures prototype methods, not only static ones.

## [2.3.0]

### Changed
- **The method name is the route.** `/{prefix}/{methodName}`, matched against
  the class's real method list — no string parsing, and no collision between
  `getProduct` and `getProductCategory`.

## [2.2.0]

### Fixed
- Four middleware bugs.

## [2.1.0]

### Added
- Per-function rate limiting, configured from `@CloudFunction`.

## [2.0.0]

### Added
- Complete toolkit: all decorators, registries, middleware and Swagger.
- Swagger and trigger registration built into `@ParseClass`.

## [1.0.0]

### Added
- `@ParseClass`, `@ParseField`, `BaseModel`, schema types.
