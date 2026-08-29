<div align="center">

# parse-server-kit

**A working backend in an afternoon, not a fortnight.**

Decorator-driven toolkit for [Parse Server](https://github.com/parse-community/parse-server).
Write models and endpoints as TypeScript classes — get REST routes, OpenAPI docs,
schema, indexes, validation, transactions and row-level security for free.

[![CI](https://github.com/walhalabi-code/parse-server-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/walhalabi-code/parse-server-kit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/parse-server-kit.svg)](https://www.npmjs.com/package/parse-server-kit)
[![license](https://img.shields.io/npm/l/parse-server-kit.svg)](./LICENSE)

</div>

---

## Why

Most backends are the same backend: users, roles, permissions, CRUD, file
uploads, a search endpoint, some scheduled jobs, and an admin panel that needs
to see more than everyone else.

Parse Server already ships that — auth, sessions, roles, **row-level ACL**,
real-time subscriptions, file storage, push. What it doesn't ship is a pleasant
way to write against it. Cloud code is untyped functions in a folder.

This kit is the missing layer:

```ts
@ParseClass('Product', {clp: {find: {[roleKey(UserRoles.ADMIN)]: true}}})
export default class Product extends BaseModel {
  @ParseField({type: 'String', required: true, unique: true})
  sku!: string;

  @ParseField({type: 'Number', min: 0})
  price!: number;

  @ParseField({type: 'Pointer', targetClass: 'Category'})
  category!: Category;
}
```

That one class gives you a typed model, a database schema, a unique index, a
MongoDB validator, class-level permissions, and an OpenAPI schema. No
migrations to write, no route file to update, no DTO to duplicate.

### Honestly, compared to NestJS

|  | NestJS | parse-server-kit |
|---|---|---|
| Auth, sessions, users, roles | you build it | ✅ built in |
| **Row-level permissions (ACL)** | you build it | ✅ built in |
| Real-time subscriptions | you wire websockets | ✅ LiveQuery |
| File storage + adapters | you build it | ✅ built in |
| Schema & migrations | Prisma/TypeORM | ✅ from decorators |
| REST routes | `@Controller` | ✅ from method names |
| OpenAPI | `@nestjs/swagger` | ✅ automatic |
| DI container, modules | ✅ | ❌ |
| Guards / interceptors / pipes | ✅ | ❌ (roles only) |
| Rich DTO validation | ✅ class-validator | ⚠️ field-level only |
| Ecosystem size | enormous | small |

**Use NestJS** if you need a DI container, module boundaries, or a large team
with enforced architecture. **Use this** if you want the boring 80% of a
backend to already exist and you'd rather ship features today.

---

## Install

```bash
npm install parse-server-kit parse-server parse express reflect-metadata
npm install -D @types/parse
```

**`experimentalDecorators` is mandatory** — TypeScript 5 defaults to standard
(TC39) decorators, which are a different feature. Without it every decorator
silently misbehaves:

```jsonc
{"compilerOptions": {"experimentalDecorators": true}}
```

**Prefer `declare` for model fields:**

```ts
@ParseField({type: 'String'}) declare title: string;   // ✅ preferred
@ParseField({type: 'String'}) title!: string;          // works — repaired at runtime
```

`@ParseField` puts a getter/setter on the prototype; the declaration exists
only to give TypeScript the type. The `!` form emits a real class field that
**shadows that accessor** whenever `useDefineForClassFields` is on — its
default from `target: ES2022` up.

**Since 3.0.0 `@ParseClass` repairs that automatically**, so either form works:
the shadowing property is removed on construction and any value it held is
routed through the accessor. Before 3.0.0 the `!` form meant reads returned
`undefined` and `save()` quietly sent nothing.

`declare` is still the form to write — it emits no field at all, so there is
nothing to repair, and it is correct under every target. `emitDecoratorMetadata`
is *not* needed.

> `psk new` generates models with `declare` already.

---

## Configuration

Optional. Every default matches what the library did before these were
settings, so you can skip this entirely:

```ts
import {configureKit} from 'parse-server-kit';

configureKit({
  mountPath: '/api',          // where Parse Server is mounted (default '/parse')
  adminRole: 'Owner',         // role that manages _Role (default 'SuperAdmin')
  excludedPointerClasses: ['Attachment'],  // skipped by fromParams()
});
```

**Roles are yours to define.** `roleKey` accepts any string and keeps the
literal type, so use your own enum:

```ts
export enum Roles {OWNER = 'Owner', MEMBER = 'Member', BILLING = 'Billing'}

@ParseClass('Invoice', {clp: {find: {[roleKey(Roles.BILLING)]: true}}})
```

---

## Quickstart

```bash
npx parse-server-kit new my-api
cd my-api
docker compose up -d      # MongoDB as a replica set, so transactions work
npm install
npm run dev
```

That's a working API with OpenAPI docs at `/api-docs`, a seeded user, and both
mandatory tsconfig flags already set. The server prints a ready-to-paste `curl`
on startup:

```
✓ Created my-api — 10 files

  Your API is running.
  Docs   http://localhost:1337/api-docs

    curl "http://localhost:1337/api/notes/listNotes" \
      -H "X-Parse-Application-Id: my-api"
```

No Docker? Put a MongoDB Atlas connection string in `.env` as `DATABASE_URI`
and skip `docker compose`.

> **Why a replica set?** A default MongoDB install is a *standalone*, and
> standalones refuse transactions — so `@Transactional` and `@ParseVersionField`
> would fail against one. The generated `docker-compose.yml` configures a
> single-node replica set to avoid that.

Once installed globally the command is `psk`:

```bash
npm i -g parse-server-kit
psk new my-api
psk --help
```

---

## Writing it by hand

**1. A model**

```ts
import {ParseClass, ParseField, BaseModel, BeforeSave} from 'parse-server-kit';

@ParseClass('Product')
export default class Product extends BaseModel {
  @ParseField({type: 'String', required: true})
  name!: string;

  @ParseField({type: 'Number', min: 0})
  price!: number;

  @BeforeSave()
  static async onBeforeSave(req: Parse.Cloud.BeforeSaveRequest<Product>) {
    validateOrThrow(req.object);
  }
}
```

**2. Endpoints — the method name is the route**

```ts
import {Route, CloudFunction, catchError} from 'parse-server-kit';

@Route(Product)                                   // → /api/products/*
class ProductFunctions {
  @CloudFunction({methods: ['POST'], validation: {requireUser: true}})
  static async createProduct(req: Parse.Cloud.FunctionRequest) {
    const product = Product.fromParams(req.params);
    const [err, saved] = await catchError(product.save(null, {sessionToken: req.user!.getSessionToken()}));
    if (err) throw err;
    return saved;                                 // POST /api/products/createProduct
  }

  @CloudFunction({methods: ['GET']})
  static async listProducts(req: Parse.Cloud.FunctionRequest) {
    return new Parse.Query(Product).limit(Number(req.params.limit) || 20).find();
  }                                               // GET /api/products/listProducts
}
```

**3. Boot** — order is load-bearing; see [CLAUDE.md](./CLAUDE.md#boot-order).

```ts
importFiles(join(__dirname, 'models'));           // models FIRST
const parseServer = await initializeParseServer();

app.use(removeResultMiddleware);
app.use(mountPath, validateEntityRoutes);
app.use(conditionalJsonMiddleware);
app.use(mountPath, restrictRoutes);               // blocks /classes, /schemas, /batch
app.use(mountPath, parseServer.app);

CloudFunctionRegistry.initialize();               // registries AFTER mount
TriggerRegistry.initialize();
CronRegistry.initialize();
setupSwagger(app, {title: 'My API', version: '1.0.0'});
```

Your API is now at `/api/products/*`, documented at `/api-docs`, with
`/classes` and `/schemas` closed off.

---

## What's in the box

| | |
|---|---|
| **Models** | `@ParseClass` · `@ParseField` · `BaseModel.fromParams()` · typed getters |
| **Endpoints** | `@CloudFunction` · `@Route` · role checks · per-function rate limiting |
| **Triggers** | all 21 Parse trigger types, including file, config and LiveQuery |
| **Cron** | `@Cron` with `CronSchedule` presets, timezones, runtime control |
| **Transactions** | `@Transactional()` — every write in the call chain joins automatically |
| **Optimistic locking** | `@ParseVersionField()` — one line, enforced in the database adapter |
| **ACL** | `implementACL()` · role/owner/public rules · nested-image ACL sync |
| **Indexes** | unique, compound, TTL, 2dsphere, text — all from decorators |
| **Validation** | field constraints, enforced in code *and* as MongoDB `$jsonSchema` |
| **OpenAPI** | generated from your decorators, no annotations needed |

### Transactions that follow the call, not the request

Parse Server's own transaction keeps its session on the shared
`DatabaseController`, so one cloud function's transaction swallows every
unrelated request running at the same moment. This one lives in
`AsyncLocalStorage`, so two callers each get their own:

```ts
@CloudFunction({methods: ['POST']})   // must be ABOVE
@Transactional()                      // must be BELOW — decorators apply bottom-up
static async placeOrder(req) {
  await order.save(null, {useMasterKey: true});
  await inventory.save(null, {useMasterKey: true});   // joins automatically
}                                                     // both land, or neither
```

### Optimistic locking in one line

```ts
@ParseVersionField()
version!: number;
```

That's the whole feature. Every read carries its version, every save asserts
it, the adapter turns the assertion into the write's filter, and a stale save
is refused with `CONFLICT` — with no endpoint reading or writing the field.

---

## Documentation

**[CLAUDE.md](./CLAUDE.md)** is the complete API reference: every export with
its real signature, the boot-order contract, and — most usefully — a table of
[every way this library fails without raising an error](./CLAUDE.md#silent-failures).
It ships inside the package, so it's also available to coding agents at
`node_modules/parse-server-kit/CLAUDE.md`.

## Requirements

| | |
|---|---|
| Node | **≥ 20.19** |
| parse-server | ≥ 8.3 (optional peer) |
| MongoDB | ≥ 7.0.16 for parse-server 9; **replica set** for transactions |
| TypeScript | any, with `experimentalDecorators: true` |

Transactions and `@ParseVersionField` are **MongoDB only**. On Postgres the
version field is declared but never enforced — and says so at boot.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bug reports are most useful with
your `parse-server`, `parse`, Node and MongoDB versions, and whether
`experimentalDecorators` is set.

## License

MIT © Waseem Alhalabi — see [LICENSE](./LICENSE).
