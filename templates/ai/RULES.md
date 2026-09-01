# {{PROJECT_NAME}} — working rules

A Parse Server backend built with
[parse-server-kit](https://www.npmjs.com/package/parse-server-kit).

Read this before writing code in this repository. **Almost every way this
library goes wrong produces no error at all** — the server starts, the request
returns 200, and the data is quietly wrong. The rules below are the ones that
fail silently; they are not style preferences.

The library's full API reference ships inside the package at
`node_modules/parse-server-kit/CLAUDE.md`. Read it when you need a signature.

---

## The rules that fail silently

### 1. Model fields use `declare`, never `!:`

`@ParseField` installs a getter and setter on the **prototype**. Writing
`title!: string` makes TypeScript emit a real class field — an own property set
to `undefined` — which shadows that accessor. Reads then return `undefined`,
writes land on the own property instead of Parse's attribute store, and `save()`
sends nothing.

```ts
// CORRECT
@ParseField({type: 'String', required: true})
declare title: string;

// WRONG — reads as undefined, writes are lost, nothing is logged
@ParseField({type: 'String', required: true})
title!: string;
```

### 2. `@CloudFunction` goes ABOVE `@Transactional()`

Decorators apply bottom-up, and `@CloudFunction` captures the method as it is
applied. Reversed, the registry keeps the **unwrapped** method: the transaction
never opens, every write commits on its own, and nothing is logged.

```ts
// CORRECT
@CloudFunction({methods: ['POST']})   // must be above — sees the wrapped method
@Transactional()                      // must be below — does the wrapping
static async submitJob(req) { ... }
```

### 3. `implementACL` takes a description and RETURNS an ACL

It does not take the object. There is no other signature.

```ts
// CORRECT
order.setACL(implementACL({
  roleRules: [{role: 'Admin', read: true, write: true}],
  owner: [{user: req.user, read: true, write: true}],
  publicRead: status === 'published',
}));

// WRONG — will not compile, and is the most common mistake
implementACL(order, {readRoles: [...], writeRoles: [...]});
```

Three things about it that are easy to get wrong:

- **Omitting `read` means `read: false`.** It revokes; it does not "leave as is".
- **`publicRead` is written on every call.** Passing an existing ACL as the
  second argument without restating `publicRead` takes public read away.
- **`excludedRoles` skips the rule, it does not deny the role.** An existing
  grant for an excluded role survives. To revoke, name the role with nothing
  allowed and do not exclude it.

### 4. Triggers only register on a class that also has `@ParseClass`

On a plain class they park in metadata and are never registered. No warning.

### 5. Build request objects with `fromParams`, not `set()` calls

`Model.fromParams(req.params)` reads the `@ParseField` metadata and converts
Pointers, arrays of Pointers, Dates and GeoPoints. It ignores keys that are not
declared fields, so an unexpected key cannot reach the database.

```ts
const order = Order.fromParams(req.params);
```

It does **not** handle nested objects carrying extra data (line items, for
example) — write that loop explicitly.

### 6. Never let the client decide identity, money or status

`fromParams` sets every declared field the body carries. A field the server
owns — a price, a status, an owner, a counter — is therefore settable by anyone
who can reach the endpoint. Nothing throws; the row just saves with a value
nobody chose.

Mark those fields on the **model**, so it holds wherever `fromParams` is used:

```ts
@ParseField({type: 'Number', min: 0, clientWritable: false})
declare totalCents: number;

@ParseField({type: 'Pointer', targetClass: '_User', clientWritable: false})
declare customer: Parse.User;
```

`fromParams` then discards those keys whatever the request contains. Your own
code is unaffected — the flag governs that one function, not the field:

```ts
const order = Order.fromParams(req.params);
order.customer = req.user!;          // your code, still fine
order.totalCents = await priceIt();
```

Overwriting after the call also works and is still correct, but it depends on
remembering, in every endpoint, forever. The declaration does not.

### 7. Paginate with `paginate`, not by hand

```ts
const query = new Parse.Query(Order).descending('createdAt');
return paginate<Order>(query, req.params, {useMasterKey: true});
// → {results, count, limit, skip, hasMore}
```

`count` is the **total matching rows**, not the size of this page. The
hand-written version that returns `results.length` runs perfectly and gives a
client a number it cannot paginate with.

**Sort the query.** Pagination over an unsorted query is unstable — MongoDB
guarantees no order without one, so rows can appear on two pages or none.

### 8. GET parameters arrive as strings

`validateEntityRoutes` merges the query string into the body. Declare them as
`{type: String}` and convert:

```ts
const active = req.params.isActive === 'true';
```

`paginate` already reads `limit` and `skip` this way.

### 9. Cast query results to the typed model

`Parse.Query` returns `Parse.Object`, so `row.title` is unavailable until you
say what it is:

```ts
const rows = await query.find({useMasterKey: true});
return rows as Product[];
```

### 10. Pointer and Relation fields require `targetClass`

Without it the decorator throws at import — which is the good case. An **Array**
field without `targetClass` fails quietly instead: the values stay as the client
sent them, so a list of ids stays a list of strings that no query will match.

### 11. `@ParseVersionField` declares its own field

No `@ParseField` above it.

```ts
@ParseVersionField()
declare version: number;
```

---

### 12. `requiresAuth` and `rateLimit` are enforced — so mean them

```ts
@CloudFunction({
  methods: ['POST'],
  requiresAuth: true,                     // refused with no session
  rateLimit: {windowMs: 60000, max: 10},  // enforced on every path in
})
```

`requiresAuth` refuses a caller with no session before the body runs. The master
key passes — a cloud function called as the system is not an anonymous caller.

`rateLimit` applies whether the caller comes through the entity route or asks
for `/functions/{name}` directly. It is **per process**, so N instances behind a
load balancer means N times the limit.

`methods` applies to the entity route only. `/functions/{name}` is Parse's own
protocol endpoint and `Parse.Cloud.run` always POSTs to it, so a GET-declared
function is still reachable that way.

Before 3.0.0 `requiresAuth` did nothing at all, and `rateLimit` was skipped on
the `/functions` path. Older code treating either as documentation is out of
date.

`validation: {requireUser: true}` does the same job as `requiresAuth` through
Parse Server's own validator. Either is fine; both together is harmless.

---

## Conventions in this repository

- **Errors:** use `catchError`, not `try/catch` around `await`.
  ```ts
  const [err, saved] = await catchError(order.save(null, {useMasterKey: true}));
  if (err) throw err;
  ```
- **CLP and ACL keys:** `roleKey('Admin')`, never the literal `'role:Admin'`.
- **Routing:** the method name **is** the route. `createOrder` in a class
  decorated `@Route(Order)` becomes `POST /api/orders/createOrder`. There is no
  route table to update.
- **Registration:** none. `importFiles` picks up new models and functions at
  boot. Do not add an index file or a registration call.
- **Validation:** put `validateOrThrow(obj)` in a `@BeforeSave` trigger so it
  runs on every save path, not only the endpoint you are writing.
- **Money:** integers, in the smallest unit. Never floats.

## Where things live

```
src/
  app.ts             boot order — the sequence is load-bearing, do not reorder
  seed.ts            roles, first admin, sample rows (idempotent)
  models/            one file per @ParseClass
  functions/         one file per @Route class
```

## Adding an entity

Run the generator rather than writing the files by hand — it derives the plural,
the route prefix and the file names consistently:

```bash
psk g resource Product
```

Then fill in the fields. Nothing else needs to change.

## Everything the library exports

You do not need the detail here — the point is to know what **exists**, so you
reach for the built-in rather than reinventing it. Full signatures are in
`node_modules/parse-server-kit/CLAUDE.md`.

| Area | Exports |
|---|---|
| **Models** | `ParseClass` · `ParseField` · `BaseModel` · `getSchemaDefinition` · `classNames` |
| **Endpoints** | `CloudFunction` · `ProtectedCloudFunction` · `Route` · `CloudFunctionRegistry` · `RouteRegistry` |
| **Triggers** | `BeforeSave` `AfterSave` · `BeforeDelete` `AfterDelete` · `BeforeFind` `AfterFind` · `BeforeLogin` `AfterLogin` `AfterLogout` · `BeforePasswordResetRequest` · `BeforeSaveFile` `AfterSaveFile` `BeforeDeleteFile` `AfterDeleteFile` `BeforeFindFile` `AfterFindFile` · `BeforeSaveConfig` `AfterSaveConfig` · `BeforeConnect` `BeforeSubscribe` `AfterEvent` · `TriggerRegistry` |
| **Scheduled jobs** | `Cron` · `CronSchedule` · `CronRegistry` |
| **Permissions** | `implementACL` · `syncImageAcl` · `cloneAcl` · `roleKey` · `UserRoles` *(deprecated — use plain strings)* |
| **Validation** | `validateOrThrow` · `validateObject` · `getValidators` · `applyMongoValidators` |
| **Transactions** | `Transactional` · `withTransaction` · `inTransaction` · `currentSession` · `CONFLICT` · `CONFLICT_MESSAGE` |
| **Optimistic locking** | `ParseVersionField` · `VersionRegistry` · `createVersionedMongoAdapter` · `VERSION_CONFLICT` · `VERSION_CONFLICT_MESSAGE` |
| **Indexes** | `applyAllIndexes` · `getUniqueIndexes` · `getCompoundIndexes` · `getFieldIndexes` |
| **Schema** | `createSchemaConfig` |
| **Middleware** | `validateEntityRoutes` · `restrictRoutes` · `removeResultMiddleware` · `conditionalJsonMiddleware` · `checkRateLimit` · `validateFunctionRoutes` *(legacy `/functions/*` — do not add to new projects)* |
| **Config** | `configureKit` · `kitConfig` · `resetKitConfig` |
| **Role cache** | `configureRoleCache` · `invalidateRoles` · `roleCacheEnabled` · `roleCacheStats` |
| **Swagger** | `setupSwagger` · `generateSwaggerSpec` · `getSwaggerJson` |
| **Utilities** | `catchError` · `getUserRoles` · `getUsersRoles` · `importFiles` · `sleep` · `formatCount` · `generateRandomString` · `generateRandomPassword` · `generateRandomInteger` · `MAX_QUERY_LIMIT` |

Three of these have traps worth knowing before you use them:

- **`syncImageAcl`** must run **after** the parent's final ACL is set and
  **before** saving, or nested images keep the visibility they were stamped with.
- **`configureRoleCache`** is off by default for a reason: a **revoked role keeps
  working** until its entry expires. Call `invalidateRoles(userId)` wherever you
  grant or revoke.
- **`Cron`** silently does nothing without `node-cron` installed —
  `initialize()` warns and skips, and no job ever runs.

## Before you say it works

- `npm run build` — the decorators are compile-time; a type error is a real error.
- New model? Check the boot log for `Registered Parse class: <Name>`.
- New endpoint? Check `Route: /<prefix>/<method>` in the boot log.
- Changed permissions? A row the caller may not read returns **"Object not
  found"**, not "forbidden" — that is correct, not a bug.
