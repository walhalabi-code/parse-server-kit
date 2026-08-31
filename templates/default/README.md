# {{PROJECT_NAME}}

A Parse Server API built with [parse-server-kit](https://www.npmjs.com/package/parse-server-kit).

## Run it

```bash
npm run db:up            # MongoDB (replica set, so transactions work)
npm run dev
```

The server prints a ready-to-paste `curl` on startup, including a session token
for a seeded `demo` user.

Not using Docker? Put a MongoDB Atlas connection string in `DATABASE_URI` and
skip the first command.

## Try it

```bash
# list (no auth needed)
curl "http://localhost:1337/api/notes/listNotes" \
  -H "X-Parse-Application-Id: {{APP_ID}}"

# create (needs the session token printed at startup)
curl -X POST "http://localhost:1337/api/notes/createNote" \
  -H "X-Parse-Application-Id: {{APP_ID}}" \
  -H "X-Parse-Session-Token: <token from startup>" \
  -H "Content-Type: text/plain" \
  -d '{"title":"My first note"}'
```

Interactive docs: **http://localhost:1337/api-docs**

## Admin dashboard

Parse has an official admin console — browse and edit every class, run queries,
inspect users and roles. It is **not installed by default**: it is a bundled
React app, and plenty of services never expose one.

```bash
npm install parse-dashboard
npm run dev
```

Restart and it is at **http://localhost:1337/dashboard**. `app.ts` detects it;
there is nothing to wire.

> **It holds the master key**, so it reads and writes every class regardless of
> CLP or ACL. Set `DASHBOARD_USER` and `DASHBOARD_PASS` in `.env`. Unset in
> development it opens to `admin` / `change-me-now` and warns on every boot;
> unset in production it refuses to mount at all.

## What's here

```
src/
  app.ts              boot order — the sequence is load-bearing
  roles.ts            your roles, declared once
  env.ts              every setting, in one place
  seed.ts             roles, the first admin, and sample rows
  note.test.ts        a starting point for tests
  models/Note.ts      @ParseClass + @ParseField + a @BeforeSave trigger
  functions/note.ts   @Route + @CloudFunction — the method name is the route
  server/             plumbing: startup banner, dashboard mount
```

`src/roles.ts` is where your role names live. Declaring them once matters more
than it looks: a role name has to agree in four places — the schema, the seed,
every model's CLP and every endpoint's `requireRoles` — and a typo grants
nothing at all rather than failing. `roleKey(Roles.EDITOR)` makes a misspelling
a compile error.

`src/models/Note.ts` is worth reading first. That one class produces the
database schema, a unique index on `slug`, a MongoDB validator enforcing the
length and enum rules, the class-level permissions, and the OpenAPI schema —
with no migration to write and no separate DTO to keep in step.

## Routes

**The method name is the route.** `createNote` → `POST /api/notes/createNote`.
Rename the method and the route follows; there is no route table.

| Method | Route |
|---|---|
| POST | `/api/notes/createNote` |
| GET | `/api/notes/listNotes` |
| GET | `/api/notes/getNote` |
| POST | `/api/notes/updateNote` |
| POST | `/api/notes/deleteNote` |

`/classes`, `/schemas` and `/batch` are blocked by `restrictRoutes`, so clients
can only reach the endpoints you declare.

## Two tsconfig flags you must not remove

Both are already set in `tsconfig.json`, and **both fail silently** if removed:

- `experimentalDecorators: true` — TypeScript 5 defaults to standard (TC39)
  decorators, which are a different feature.
- `useDefineForClassFields: false` — otherwise every `@ParseField` reads as
  `undefined` while `.get('field')` still returns the value.

## Tests

```bash
npm test
```

Node's own test runner — nothing to install, no config file. `src/note.test.ts`
checks the things that go wrong without raising an error: that a field written
on a model actually reaches Parse (rather than landing on a shadowed class
field), that `save()` would really send it, and that the rules declared on the
schema are enforced by the trigger.

When you want tests that hit the database, the hard part is already done: the
`docker-compose.yml` here starts a replica set, which is what Parse needs for
transactions.

## Adding a model

1. Create `src/models/Thing.ts` with `@ParseClass` and `@ParseField`.
2. Create `src/functions/thing.ts` with `@Route(Thing)` and `@CloudFunction`.

That is all — `importFiles` picks both up at boot. There is no index file to
update and no registration step.

## Seeding

An empty database has no roles, so every role-gated endpoint refuses everyone —
including you. `src/seed.ts` fixes that, and splits the job in two:

- **`seed()`** — the `Editor` and `Admin` roles, the hierarchy between them, and
  the first admin user. Reference data the app cannot run without. Safe in
  production.
- **`seedSampleData()`** — a `demo` / `demo-password` user and two example
  notes, so the API returns something on the first request. Development only;
  `app.ts` skips it when `NODE_ENV=production`.

Both are idempotent — find first, create only if missing — so re-running changes
nothing. That is what makes it safe to put in a deploy step.

```bash
npm run seed        # standalone; the server must be running
```

At boot it runs automatically unless `NODE_ENV=production`. Override either way
with `SEED_ON_BOOT` in `.env`.

**Set `ADMIN_PASSWORD` before this leaves your machine.** Without it the seed
uses a known default and the server warns on every boot. Delete
`seedSampleData` once you have real data.
