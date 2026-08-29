# Contributing

Thanks for looking. This is a small library with a clear scope, so the most
useful contributions are usually narrow ones.

## Getting set up

```bash
npm install
npm test                  # unit — fast, no database
npm run test:integration  # real parse-server on an in-memory MongoDB replica set
npm run test:all
```

The first integration run downloads a MongoDB binary. After that it is cached.

## What this library is

A decorator layer **on top of** Parse Server. It does not modify parse-server,
and it should not need to — `parse-server` is an optional peer dependency, and
the one place we touch its internals (`MongoStorageAdapter`) is extended by
subclassing.

If a change would require forking or patching parse-server, it probably belongs
upstream as a PR to
[parse-community/parse-server](https://github.com/parse-community/parse-server)
instead.

## What this library is not

- Not an application framework. There is no DI container and no module system,
  and adding them is out of scope.
- Not a place for project-specific conventions. If a change only makes sense
  for one codebase's naming or file layout, it belongs in that codebase.

## Things worth knowing before you change something

**Most failures in this library are silent.** `CLAUDE.md` has a table of them.
When you add a feature, ask what happens if it is misconfigured — and if the
answer is "nothing, quietly", log something. Four of those were converted to
warnings in 2.8.0 and it is the single highest-value habit here.

**Decorator order is load-bearing.** Decorators apply bottom-up, and
`@CloudFunction` captures the method when it is applied. Anything that wraps a
method has to sit below it.

**The transaction and versioning code depends on parse-server internals** —
`MongoStorageAdapter`'s module path, `_adaptiveCollection`, `_mongoCollection`,
`_getSaveJSON`, and the argument position of `options` on every driver method
in `OPTIONS_ARGUMENT`. The integration suite exists specifically to catch an
upstream release moving any of them. **Run `npm run test:integration` before
opening a PR that touches `src/transactions/` or `src/database/`.**

## Pull requests

- Add a test. The middleware, routing and decorator layers had no tests for a
  long time and that was a mistake we are still paying down.
- Keep the public API backwards compatible, or say clearly in the PR that it
  is not and why.
- Update `CLAUDE.md` if you change a signature. It is the API contract, and it
  ships inside the package.
- Add a `CHANGELOG.md` entry under an `## [Unreleased]` heading.

## Reporting a bug

Please include the versions of `parse-server`, `parse`, Node, and MongoDB, and
say whether `experimentalDecorators` is set. A surprising number of reports
come down to that flag, because TypeScript 5 defaults to standard decorators
and this library uses legacy ones.

## Releasing

Maintainers only:

```bash
npm run test:all
npm version <patch|minor|major>
npm publish
git push --follow-tags
```
