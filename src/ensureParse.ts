/**
 * Guarantee `global.Parse` exists before any other module dereferences it.
 *
 * This library reads the global `Parse` the way cloud code does, rather than
 * importing the SDK itself — so a model can subclass `Parse.Object` and get the
 * same instance the rest of your app uses. That works because importing
 * `parse-server` sets the global as a side effect, and the documented boot
 * order puts it first.
 *
 * A **standalone script** breaks that assumption. A seed, a migration or a
 * one-off task imports this library at the top of the file, long before it
 * decides how to reach the server — and ES import hoisting means the library
 * loads before the script's first statement runs. `BaseModel extends
 * Parse.Object` is evaluated while the class is defined, so the failure is:
 *
 *     ReferenceError: Parse is not defined
 *         at .../dist/models/BaseModel.js:5
 *
 * which points into this package's internals and says nothing about what the
 * caller did wrong.
 *
 * So: if the global is missing, load the SDK ourselves. `parse` is a required
 * peer dependency, so it is installed wherever this library is. The fallback
 * fires ONLY when nothing has set the global, which means nothing can yet be
 * holding a different Parse instance — importing `parse-server` afterwards
 * finds the global already set and reuses it, so there is still exactly one.
 *
 * Imported for its side effect, and imported FIRST in `index.ts`. Import order
 * is the whole point: TypeScript emits `require` calls in source order, so this
 * has to sit above every export that touches `Parse`.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

const globalScope = globalThis as {Parse?: unknown};

if (typeof globalScope.Parse === 'undefined') {
  try {
    // `parse/node` rather than `parse`: the Node build, with the file and
    // crypto pieces the browser build leaves out.
    globalScope.Parse = require('parse/node');
  } catch {
    // Deliberately silent. If `parse` genuinely is not installed, the error
    // raised by the first real dereference names the module that needed it,
    // which is more useful than one thrown from here during import.
  }
}

export {};
