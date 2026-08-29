---
name: parse-endpoint
description: Use when adding or changing an HTTP endpoint in this project — @Route, @CloudFunction, request decoding with fromParams, role gating, transactions, or ACLs on the rows an endpoint creates. Covers the decorator-order trap that silently disables transactions.
---

# Writing an endpoint

**The method name is the route.** `createOrder` in a class decorated
`@Route(Order)` becomes `POST /api/orders/createOrder`. Rename the method and
the route follows. There is no route table.

## The shape

```ts
import {
  Route, CloudFunction, Transactional, catchError, implementACL, MAX_QUERY_LIMIT,
} from 'parse-server-kit';
import Order from '../models/Order';

@Route(Order)
class OrderFunctions {
  @CloudFunction({
    methods: ['POST'],
    description: 'Place an order',
    validation: {requireUser: true, fields: {lines: {required: true}}},
    requireRoles: ['Customer'],          // enforced before the body runs
    swagger: {tags: ['Orders']},
  })
  static async createOrder(req: Parse.Cloud.FunctionRequest) {
    // Decodes pointers, dates, geopoints and id-arrays from the body using
    // the model's @ParseField metadata. Undeclared keys are ignored.
    const order = Order.fromParams(req.params);

    // The server decides identity, not the request body.
    order.customer = req.user!;

    const [err, saved] = await catchError(
      order.save(null, {sessionToken: req.user!.getSessionToken()})
    );
    if (err) throw err;
    return saved;
  }
}

export default OrderFunctions;
```

## MUST

- **`@CloudFunction` above `@Transactional()`.** Decorators apply bottom-up and
  `@CloudFunction` captures the method as it is applied. Reversed, the registry
  keeps the unwrapped method: the transaction never opens, and nothing is
  logged.
  ```ts
  @CloudFunction({methods: ['POST']})   // above
  @Transactional()                      // below
  static async submitJob(req) { ... }
  ```
- **Convert GET parameters.** They arrive as strings — the query string is
  merged into the body. `Number(req.params.limit) || 20`,
  `req.params.flag === 'true'`.
- **Cast query results.** `Parse.Query` returns `Parse.Object`;
  `rows as Product[]` before touching typed properties.
- **Cap `limit`.** `Math.min(Number(req.params.limit) || 20, MAX_QUERY_LIMIT)`.
- **Use `catchError`**, not `try/catch` around `await`.
- **Set an ACL on anything you create** that is not meant to be world-readable.
  `implementACL` takes a description and **returns** an ACL — it does not take
  the object.

## NEVER

- Never trust the body for identity, price, status or ownership. `fromParams`
  decodes every declared field, including those. Overwrite them after the call.
- Never use `useMasterKey` to make a permission problem go away. It bypasses
  every CLP and ACL. Pass `sessionToken` so the caller's own permissions apply,
  and reach for the master key only when the operation genuinely is the
  system's.
- Never add a route table entry, or register the class. `importFiles` finds it.
- Never name two methods the same in one `@Route` class.

## Choosing the auth gate

| Need | Use |
|---|---|
| Signed in | `requiresAuth: true` **or** `validation: {requireUser: true}` |
| A role | `requireRoles: ['Admin']` — any of them |
| Every role listed | `requireRoles: [...], requireAllRoles: true` |
| Signed in + POST, pre-set | `@ProtectedCloudFunction()` |

`requiresAuth` and `validation.requireUser` do the same job by different routes —
the first in this library's wrapper, the second through Parse Server's own
validator. Either is fine; both together is harmless. A call carrying the master
key passes `requiresAuth`: the system is not an anonymous caller.

`rateLimit` is enforced whether the caller comes through the entity route or asks
for `/functions/{name}` directly, and is **per process** — N instances behind a
load balancer means N times the limit.

`methods` applies to the entity route only, so `Parse.Cloud.run` (which always
POSTs to `/functions/{name}`) still reaches a GET-declared function.

`requireRoles` runs before your body: no user gives
`OBJECT_NOT_FOUND 'Authentication required'`, wrong roles give
`OPERATION_FORBIDDEN`.

## Transactions

MongoDB only, needs a replica set and `directAccess: true` on the server.
Everything inside the body joins automatically — there is no session to thread
through. **The body may re-run up to three times** on a conflict, so keep
side effects that cannot be repeated (emails, charges) outside it.

## Checking it worked

Boot and look for `Route: /orders/createOrder → createOrder` and
`Registered cloud function: createOrder`. Then check `/api-docs` — the endpoint
documents itself, with query parameters for GET and a JSON body for everything
else.
