---
name: parse-triggers
description: Use when adding or changing a Parse trigger in this project — beforeSave, afterSave, delete, find, login, file, config or LiveQuery hooks. Covers the trap where a trigger declared on the wrong class silently never registers.
---

# Triggers

Server-side hooks that run on **every** save path, not only the endpoint you
happened to write. That is the point of them: validation, derived fields and
ACLs belong here, because an endpoint you add next month gets them for free.

All of them are **static-method decorators** taking an optional
`{description?, validation?}`.

## The shape

```ts
@ParseClass('Order', {...})              // REQUIRED — see below
export default class Order extends BaseModel {

  @BeforeSave()
  static async onBeforeSave(req: Parse.Cloud.BeforeSaveRequest<Order>) {
    const order = req.object as Order;

    if (!order.status) order.status = 'pending';   // defaults
    validateOrThrow(order);                        // the model's own rules
    order.setACL(implementACL({ ... }));           // permissions, every save
  }
}
```

## MUST

- **The class must also have `@ParseClass`.** A trigger on a plain class parks
  in metadata and is **never registered** — no error, no warning, and the
  trigger simply never fires. This is the single most common trigger bug.
- **One trigger per `className:type`.** A second registration warns and
  overwrites the first.
- **Cast `req.object`** — `req.object as Order` — or typed properties are
  unavailable.
- **Throw `Parse.Error` to reject**, not a bare `Error`. The code reaches the
  client; a bare Error becomes a 500.

## NEVER

- Never do slow work in a `beforeSave`. It runs on every write, inside the
  request. Queue it or do it in `afterSave`.
- Never assume `req.user` exists. A save with the master key has none.
- Never `save()` `req.object` inside its own `beforeSave` — mutate it and
  return; the save is already happening.

## Every trigger type

| Decorator | Registers as |
|---|---|
| `@BeforeSave` `@AfterSave` | `beforeSave(className)` / `afterSave` |
| `@BeforeDelete` `@AfterDelete` | `beforeDelete` / `afterDelete` |
| `@BeforeFind` `@AfterFind` | `beforeFind` / `afterFind` |
| `@BeforeLogin` `@AfterLogin` `@AfterLogout` | auth triggers — **no className** |
| `@BeforePasswordResetRequest` | `beforePasswordResetRequest` — parse-server 8.5+ |
| `@BeforeSaveFile` `@AfterSaveFile` | `beforeSave(Parse.File)` / `afterSave` |
| `@BeforeDeleteFile` `@AfterDeleteFile` | `beforeDelete(Parse.File)` / `afterDelete` |
| `@BeforeFindFile` `@AfterFindFile` | `beforeFind(Parse.File)` — 8.1+ |
| `@BeforeSaveConfig` `@AfterSaveConfig` | `beforeSave(Parse.Config)` — 7.3+ |
| `@BeforeConnect` `@BeforeSubscribe` `@AfterEvent` | LiveQuery (`afterEvent` → `afterLiveQueryEvent`) |

File and Config triggers pass the **class itself**, not a name — parse-server
removed the old `beforeSaveFile()` style methods, and this library handles the
translation for you.

## Detecting a real change

`dirty()` distinguishes a field **changing** from a save that merely includes
its current value. Without it, every save is treated as a transition:

```ts
if (!order.isNew() && order.dirty('status')) {
  const previous = order.previous('status') as string;
  // ...validate the transition
}
```

## Common uses

**Derive a field rather than trusting the caller:**
```ts
if (!note.slug && note.title) {
  note.slug = note.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
```

**Re-apply permissions on every save**, so a status change updates who may
read the row — see the `parse-permissions` skill.

**Gate a transition by role:**
```ts
const roles = req.user ? await getUserRoles(req.user) : [];
if (!roles.includes('Admin')) throw new Parse.Error(119, 'Staff only');
```

**Block an account at login** — `@BeforeLogin` runs after the password is
verified but before a session is issued, which is the right place:
```ts
@BeforeLogin()
static async onBeforeLogin(req: any) {
  if (req.object.get('suspended')) throw new Parse.Error(101, 'Account suspended');
}
```

## Checking it worked

The boot log lists every registration:

```
[Triggers] Registering 1 trigger(s)...
[Triggers] Registered beforeSave for: Order
```

If your trigger is absent, the class is missing `@ParseClass` — or the file was
never imported. `TriggerRegistry.initialize()` must also run **after** the Parse
Server mount, which the generated `app.ts` already does.
