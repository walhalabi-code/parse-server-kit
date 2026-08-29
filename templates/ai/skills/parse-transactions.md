---
name: parse-transactions
description: Use when writing code that must be atomic or must not lose a concurrent update in this project — @Transactional, withTransaction, @ParseVersionField, CONFLICT handling. Covers the decorator order and directAccess settings that silently disable transactions entirely.
---

# Transactions and optimistic locking

Two different jobs, often needed together:

- **A transaction** makes several writes one unit — all or nothing.
- **A version field** stops a write landing on top of someone else's change.

A transaction alone does **not** give you the second one: two transactions can
still interleave a read-then-write. Stock going negative under load is the
classic symptom.

Both are **MongoDB only**, and both need a **replica set**. The bundled
`docker-compose.yml` provides one; a plain `mongod` install does not.

## Transactions

```ts
  @CloudFunction({ methods: ['POST'] })   // MUST be above
  @Transactional()                        // MUST be below
  static async createOrder(req: Parse.Cloud.FunctionRequest) {
    const order = Order.fromParams(req.params);
    await order.save(null, { useMasterKey: true });   // joins automatically

    for (const line of lines) {
      await line.product.save(null, { useMasterKey: true });   // same transaction
    }
  }
```

Every `save()`, `destroy()` and query inside the body joins automatically —
`AsyncLocalStorage` follows the call chain, so helpers called from the body are
inside it too. There is no session to thread through.

`withTransaction(async () => { ... })` is the same thing without a decorator.
`inTransaction()` and `currentSession()` report the ambient state.

## The two settings that silently disable it

### 1. Decorator order

`@CloudFunction` **above**, `@Transactional()` **below**. Decorators apply
bottom-up and `@CloudFunction` captures the method as it is applied. Reversed,
the registry keeps the **unwrapped** method: the transaction never opens, every
write commits on its own, and nothing is logged.

### 2. `directAccess`

```ts
const parseServer = ParseServer({
  directAccess: true,       // REQUIRED
  databaseAdapter: createVersionedMongoAdapter({ uri: DATABASE_URI }),
});
```

Without it, a `save()` in cloud code becomes an internal HTTP request that lands
in a fresh async context and writes **outside** the transaction. No symptom.

## Semantics worth knowing

- **Nested calls join** the outer transaction; the outermost caller commits.
- **The body may re-run**, up to 3 attempts, on a transient conflict. It must be
  safe to repeat — no emails, no charges, no counters incremented in memory. Do
  those *after* it commits.
- After 3 losses the caller gets `CONFLICT` (5001).
- Each concurrent request gets its **own** session.
- Never joined: `_SCHEMA`, `_Idempotency`, `_Hooks`, `_JobStatus`,
  `_GlobalConfig` — schema creation has to survive a rollback.
- An unfiltered `count()` reads **outside** the transaction; MongoDB refuses
  `count` inside one.

## Optimistic locking

One decorator is the entire feature:

```ts
@ParseClass('Product')
class Product extends BaseModel {
  @ParseVersionField()        // declares the Number field itself
  declare version: number;
}
```

No `@ParseField` above it, and **no endpoint ever reads or writes it**:

- every object **read** carries the version it was read at;
- every `save()` asserts that version, inside the write's filter, and `$inc`s it;
- a lost race is refused with `CONFLICT` (5001);
- creates get version `1` from the adapter;
- **an object built from a bare id — never read — has nothing to assert and is
  not protected.** `Model.pointer(id)` then `save()` bypasses the lock entirely.

## Handling a conflict

```ts
import { CONFLICT, CONFLICT_MESSAGE } from 'parse-server-kit';

try {
  await placeOrder(lines);
} catch (error) {
  if (error instanceof Parse.Error && error.code === CONFLICT) {
    // CONFLICT_MESSAGE is already written for an end user.
    showBanner(CONFLICT_MESSAGE);
    return reload();       // re-read, re-apply, retry
  }
  throw error;
}
```

`VERSION_CONFLICT` is the same value as `CONFLICT` — a lost lock and a lost
transaction race are the same event to the person on the screen.

## MUST

- `@CloudFunction` above `@Transactional()`.
- `directAccess: true` on the server.
- A replica set, or neither feature works.
- Keep non-repeatable side effects out of the transaction body.

## NEVER

- Never assume a version field protects an object you never read.
- Never catch `CONFLICT` and ignore it. It means the write did **not** happen.
- Never use these on Postgres — the version field is declared and never
  enforced.

## Checking it worked

`VersionRegistry.verify()` reports whether the adapter is installed and which
classes are versioned. The boot log carries `[Versioning]` lines when something
is wrong — a missing adapter, Postgres, or a Parse SDK whose `_getSaveJSON` has
moved. Read them once and you never have to wonder.
