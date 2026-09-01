---
name: parse-model
description: Use when adding or changing a Parse model in this project — @ParseClass, @ParseField, field types, indexes, class-level permissions, or a @BeforeSave trigger. Covers the field-shadowing trap that makes a model silently read as empty.
---

# Writing a model

One class produces the database schema, the indexes, the MongoDB validator, the
class-level permissions and the OpenAPI schema. There is no migration and no
DTO.

Prefer `psk g resource <Name>` to writing the files by hand — it derives the
plural, route prefix and file names consistently. Then fill in the fields.

## The shape

```ts
import {
  ParseClass, ParseField, BaseModel, BeforeSave, validateOrThrow, roleKey,
} from 'parse-server-kit';

@ParseClass('Product', {
  description: 'Something for sale',        // appears in the OpenAPI output
  clp: {
    find:   {'*': true},
    get:    {'*': true},
    count:  {'*': true},
    create: {[roleKey('Admin')]: true},
    update: {[roleKey('Admin')]: true},
    delete: {[roleKey('Admin')]: true},
  },
  compoundIndexes: [{fields: ['status', 'createdAt']}],
})
export default class Product extends BaseModel {
  constructor() { super('Product'); }

  @ParseField({type: 'String', required: true, maxLength: 200})
  declare name: string;

  @ParseField({type: 'String', required: true, unique: true})
  declare sku: string;

  // Server-owned: `clientWritable: false` makes `fromParams` discard it,
  // whatever the request body says. Your own code still sets it freely.
  @ParseField({type: 'Number', required: true, min: 0, clientWritable: false})
  declare priceCents: number;

  @BeforeSave()
  static async onBeforeSave(req: Parse.Cloud.BeforeSaveRequest<Product>) {
    const product = req.object as Product;
    if (!product.status) product.status = 'draft';
    validateOrThrow(product);       // enforces the rules declared above
  }
}
```

## MUST

- **`declare`, never `!:`.** `@ParseField` installs a prototype accessor;
  `name!: string` emits an own property that shadows it, so reads return
  `undefined` and writes are lost. Nothing is logged.
- **`targetClass` on every Pointer and Relation.** Missing, the decorator throws
  at import.
- **`targetClass` on an Array of pointers too.** Missing, it fails *silently* —
  the values stay as sent, so a list of ids never matches a query.
- **`constructor() { super('ClassName'); }`** — the class name string must match
  the `@ParseClass` argument.
- **`extends BaseModel`**, so `fromParams` and `pointer` are available.
- **`@ParseVersionField()` declares its own field** — no `@ParseField` above it.

## NEVER

- Never use `index` and `unique` together, or `geo`/`ttlSeconds` with either.
  They are mutually exclusive and throw at import.
- Never put a trigger on a class without `@ParseClass` — it parks in metadata
  and never registers, with no warning.
- Never store money as a float. Integers, smallest unit.
- Never register the model anywhere. `importFiles` finds it at boot.

## Field options

| Option | Applies to | Effect |
|---|---|---|
| `required` | any | Enforced by `validateOrThrow` and the Mongo validator |
| `targetClass` | Pointer, Relation, Array | **Required** for Pointer/Relation |
| `min` / `max` | Number | Range |
| `minLength` / `maxLength` | String | Length |
| `enum` | String | Allowed values |
| `pattern` | String | RegExp source; invalid regex throws at import |
| `unique` | any | Unique index at boot |
| `index` | any | `true \| 1 \| -1` B-tree |
| `geo` | GeoPoint | 2dsphere index |
| `ttlSeconds` | Date | TTL index |
| `description` | any | OpenAPI |

Options are validated **at import**, so a mistake fails at boot rather than in
production.

## Checking it worked

Boot the server and look for `Registered Parse class: Product` and the
`[Indexes]` lines. If the class is absent, `importFiles` did not find the file —
usually because it ran over `.ts` sources with the default `['.js']`.
