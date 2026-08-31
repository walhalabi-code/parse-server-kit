# Contributing

## Getting set up

```bash
npm install
npm test                  # 334 unit tests
npm run test:integration  # 90 more, against a real MongoDB replica set
```

The integration suite starts its own in-memory replica set. Nothing to install,
no Docker needed — but it downloads a MongoDB binary on first run, so the first
one is slow.

---

## Releasing

`main` is protected: no direct pushes, five checks must pass, PR required
(0 approvals, so you can merge your own).

**Every step matters. Two of them have each cost a failed release.**

### 1. Branch

```bash
git checkout main && git pull
git switch -c fix/what-you-are-doing
```

### 2. Make the change, and bump the version

Edit `package.json` → `"version": "3.0.4"`.

### 3. Run `npm install` — do not skip this

```bash
npm install
```

**This is the step that breaks releases.** `npm ci` — which every CI job runs
first — refuses to install when `package.json` and `package-lock.json` disagree,
and a version bump alone makes them disagree. Skip it and all five checks fail
in about 40 seconds with:

```
npm error `npm ci` can only install packages when your package.json and
npm error package-lock.json are in sync.
```

Nothing has been built or tested at that point; the run dies at the first
command. The same failure appears on Dependabot PRs whose lockfile is stale.

### 4. Verify locally

```bash
npx tsc --noEmit
npm test
```

If you touched `templates/`, scaffold a project and check it really works:

```bash
cd /tmp && node /path/to/repo/dist/cli/index.js new probe --yes --ai=none --no-install
cd probe
npm pkg set "dependencies.parse-server-kit=file:/path/to/repo"
npm install && npx tsc --noEmit && npm test
```

The `npm pkg set` line matters: the template pins `parse-server-kit` to the
version you just bumped to, which is not published yet, so a plain `npm install`
fails with `ETARGET No matching version`. Pointing at the local build is what CI
does too.

### 5. PR, wait for green, squash merge

Five checks: `Node 20`, `Node 22`, `Integration (real parse-server + MongoDB)`,
`Generated project actually runs`, `Package contents`.

### 6. Tag — **after** the merge, never before

```bash
git checkout main && git pull      # <- the pull is the point
git tag v3.0.4
git push origin v3.0.4
```

**This is the other step that breaks releases.** Tagging a branch before it
merges puts the tag on a commit whose `package.json` still has the old version,
and the release refuses it:

```
Error: Tag v3.0.4 does not match package.json version 3.0.3
```

That guard is deliberate — without it you would publish a package whose recorded
version disagrees with its own manifest, permanently, because npm versions are
immutable.

If you tagged wrongly, move it rather than burning a version:

```bash
git tag -f v3.0.4 HEAD
git push --force origin v3.0.4
```

Safe as long as nothing was published under it — and nothing was, or the release
would have succeeded.

### 7. Approve the deployment

Actions → the Release run → **Review deployments** → Approve.

Nothing reaches npm until you click. The `verify` job has already re-run the
whole suite and checked that the tag matches the manifest and that the version
is not already published.

---

## How publishing works

There is **no npm token**. Publishing uses npm's trusted publishing over OIDC:
the workflow proves its identity to npm directly, so there is no long-lived
credential to leak, rotate, or scope.

It is bound to four things, all of which must match the trusted publisher
configured on the package:

| | |
|---|---|
| Repository | `walhalabi-code/parse-server-kit` |
| Workflow | `release.yml` |
| Environment | `npm` |
| Permission | `id-token: write` |

**Renaming any of them breaks publishing.** If you rename the workflow file, the
environment, or move the repo, update the trusted publisher on npmjs.com to
match.

The release job pins npm to `^11.5.1` rather than `@latest`. OIDC publishing
needs npm ≥ 11.5.1, and `@latest` is now npm 12, which requires Node ≥ 22 and
fails `EBADENGINE` on this job's Node 20. `@latest` in CI is a moving target by
definition.

---

## Working on the templates

`templates/default/` is what `psk new` writes. A few conventions:

- Files that would confuse tooling in this repo are stored with a suffix and
  renamed on the way out. The map is `RENAMES` in `src/cli/scaffold.ts`:

  | In the repo | Generated as |
  |---|---|
  | `gitignore` | `.gitignore` |
  | `env.example` | `.env.example` |
  | `package.json.template` | `package.json` |
  | `tsconfig.json.template` | `tsconfig.json` |

  `tsconfig.json.template` is named that so editors do not treat
  `templates/default/` as a TypeScript project. There is no `node_modules`
  beneath it, so `parse-server-kit` cannot resolve, and every template file
  fills with errors that say nothing about the actual code.

- `{{PROJECT_NAME}}`, `{{APP_ID}}`, `{{MASTER_KEY}}`, `{{MAINTENANCE_KEY}}` and
  `{{KIT_VERSION}}` are substituted at scaffold time.

- The generated project must have **no test framework dependency**. Its tests
  use Node's built-in runner. Adding jest to a starter whose selling point is
  zero dependencies would be an odd look.

- Anything the generated project *promises* must work. A `README` line or a
  banner that points at a URL needs the dependency that serves it — that is how
  `/api-docs` came to 404 in 3.0.1.

---

## Docs

`docs/` is a static site served by GitHub Pages from `main`. No build step —
the HTML is the source.

**`docs/assets/search-index.json` is a committed artifact with no generator.**
It duplicates the text of every page, so editing a page leaves it stale and
search keeps returning the old wording. It has gone stale twice. When you change
page text, grep the index for the old string and update it, and mirror the same
change into `search-index.js`.

Adding a page means touching four things: the page, the sidebar `<li>` on
**every** page, `sitemap.xml`, and the search index.

---

## Things that fail silently

The library exists to make failures loud, so it is worth knowing the ones that
still bite maintainers:

- **A lockfile out of step with `package.json`** — every CI job dies at `npm ci`
  before a test runs.
- **A tag on the wrong commit** — the release guard catches it, but only after a
  full verify run.
- **The docs search index** — no error, just stale results.
- **A template file promising something not installed** — nothing fails until a
  user opens the URL.
