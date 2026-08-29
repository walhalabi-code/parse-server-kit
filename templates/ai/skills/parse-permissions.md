---
name: parse-permissions
description: Use when deciding who may read or write data in this project — class-level permissions, row ACLs, implementACL, roles, or image ACLs that must follow their parent. Covers the three implementACL behaviours that are the reverse of what the names suggest.
---

# Permissions

Two layers, and **both must pass**:

| | Scope | Set by |
|---|---|---|
| **CLP** | A whole class. "May anyone find Orders at all?" | `@ParseClass({clp})` |
| **ACL** | One row. "May this user read *this* order?" | `implementACL` at save time |

The master key bypasses both. That is why a cloud function using
`useMasterKey: true` sees everything, and why reaching for it to fix a
permission error hides the bug rather than fixing it.

## Class-level permissions

```ts
@ParseClass('Order', {
  clp: {
    // Deny everything: the only way in is a cloud function you wrote.
    find: {}, get: {}, count: {}, create: {}, update: {}, delete: {},
  },
})
```

Four forms per operation:

| Form | Means |
|---|---|
| `{'*': true}` | Anyone, signed in or not |
| `{requiresAuthentication: true}` | Any signed-in user |
| `{[roleKey('Admin')]: true}` | Members of that role |
| `{}` | Nobody except the master key |

Always `roleKey('Admin')`, never the literal `'role:Admin'`.

## Row-level ACLs

`implementACL` takes a **description** and **returns** an ACL. It does not take
the object.

```ts
order.setACL(implementACL({
  publicRead: status === 'published',
  roleRules: [{ role: 'Admin', read: true, write: true }],
  owner: [{ user: req.user, read: true, write: status === 'pending' }],
}));
```

| Parameter | Effect |
|---|---|
| `publicRead` / `publicWrite` | The `*` entry. Both default to `false` |
| `roleRules` | `{role, read?, write?}[]` |
| `owner` | `{user, read?, write?}[]` — a user id **or** a Parse.User |
| `excludedRoles` | Role names whose rule is skipped — see below |
| *second argument* | An existing ACL to modify **in place** |

## The three behaviours that surprise everyone

### 1. Omitting `read` revokes it

It is not "leave as is". Every rule you name is rewritten completely.

### 2. `publicRead` is applied on every call

Passing an existing ACL without restating `publicRead` **takes public read
away**. Inside a `@BeforeSave` that is correct — the trigger re-derives the whole
rule each save, which is what `publicRead: status === 'published'` does.

### 3. `excludedRoles` skips the rule, it does not deny the role

```ts
// Legacy already has read + write on this row.
implementACL({
  roleRules: [{ role: 'Legacy', read: false, write: false }],
  excludedRoles: ['Legacy'],          // rule skipped entirely...
}, existing);
// => role:Legacy STILL has read + write

// To actually revoke: name the role with nothing allowed, and do not exclude it.
implementACL({ roleRules: [{ role: 'Legacy' }] }, existing);
// => {}
```

The second argument is also **mutated, not copied**. Pass
`cloneAcl(existing)` if the original must survive.

## MUST

- **Set an ACL on every row that is not meant to be world-readable**, at
  creation. A row saved with no ACL is readable by anyone the CLP lets through.
- **Apply it in a `@BeforeSave` trigger**, not only in the endpoint — then every
  save path gets it, including ones added later.
- **Prefer `sessionToken` over `useMasterKey`** in cloud functions, so the
  caller's own permissions apply.

## NEVER

- Never filter by owner in a query when an ACL can do it. `find({sessionToken})`
  already returns only permitted rows; a `where` clause is a second rule that
  can fall out of step.
- Never use the master key to work around a permission error without first
  understanding which layer refused you.

## Images and nested pointers

An image pointer keeps whatever ACL it was stamped with, so a parent that
becomes private leaves publicly readable images behind. `syncImageAcl` copies
the parent's ACL onto them:

```ts
// AFTER setting the parent's final ACL, BEFORE saving it.
order.setACL(implementACL({ ... }));
syncImageAcl(order, ['cover', 'gallery']);   // single pointer or array
```

Each image gets its own copy, not a shared instance. If the parent's live ACL is
not `parent.getACL()` — a partial save object — pass it as the third argument.

## Working out which layer refused you

| Response | Means |
|---|---|
| `101 Object not found` | The **ACL**. Parse does not confirm a row exists to someone who may not read it — this is correct, not a bug |
| `119 Operation forbidden` | The **CLP** |
| `209 Invalid session token` | Not signed in at all |

A row that "disappears" for one user and not another is an ACL doing its job.
