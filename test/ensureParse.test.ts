import 'reflect-metadata';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

/**
 * The library reads `Parse` as a global rather than importing the SDK, so a
 * model can subclass the same `Parse.Object` the rest of the app uses.
 *
 * That works because `import 'parse-server'` sets the global as a side effect,
 * and the documented boot order puts it first. A standalone script — a seed, a
 * migration, a one-off task — has no reason to import parse-server at all, and
 * ES import hoisting means this library loads before the script's first
 * statement. `BaseModel extends Parse.Object` is evaluated as the class is
 * defined, so the whole package used to die on import with:
 *
 *     ReferenceError: Parse is not defined
 *         at .../dist/models/BaseModel.js:5
 *
 * `ensureParse` loads the SDK itself when the global is absent. These tests pin
 * both directions: it fills the gap, and it never replaces an instance that is
 * already there.
 */
describe('ensureParse', () => {
  const saved = (global as Record<string, unknown>).Parse;

  afterEach(() => {
    (global as Record<string, unknown>).Parse = saved;
  });

  it('sets global.Parse when nothing else has', () => {
    delete (global as Record<string, unknown>).Parse;

    jest.isolateModules(() => {
      require('../src/ensureParse');
    });

    const loaded = (global as Record<string, any>).Parse;
    expect(loaded).toBeDefined();
    // Not just any object: the thing models actually extend.
    expect(typeof loaded.Object).toBe('function');
    expect(typeof loaded.Query).toBe('function');
  });

  it('leaves an existing global.Parse untouched', () => {
    // If this replaced the global, models registered against the first instance
    // would be invisible to the second — and nothing would report it.
    const sentinel = {Object: function Sentinel() {}, marker: 'original'};
    (global as Record<string, unknown>).Parse = sentinel;

    jest.isolateModules(() => {
      require('../src/ensureParse');
    });

    expect((global as Record<string, unknown>).Parse).toBe(sentinel);
  });

  it('does not throw when it runs twice', () => {
    delete (global as Record<string, unknown>).Parse;
    expect(() => {
      jest.isolateModules(() => require('../src/ensureParse'));
      jest.isolateModules(() => require('../src/ensureParse'));
    }).not.toThrow();
  });
});

/**
 * The unit tests above run inside Jest, where `test/setup.ts` has already put
 * Parse on the global — so they can only simulate a cold start. This one is the
 * real thing: a fresh Node process, no setup file, requiring the built package
 * the way a seed script does.
 *
 * Skipped when `dist/` has not been built, so `npm test` on a clean checkout
 * does not fail for the wrong reason.
 */
describe('importing the built package cold', () => {
  const dist = join(__dirname, '..', 'dist', 'index.js');
  const itIfBuilt = existsSync(dist) ? it : it.skip;

  itIfBuilt('requires without a pre-existing global Parse', () => {
    const script = `
      if (typeof global.Parse !== 'undefined') {
        throw new Error('expected no global Parse in a fresh process');
      }
      const kit = require(${JSON.stringify(dist)});
      if (typeof kit.BaseModel !== 'function') throw new Error('no BaseModel');
      if (typeof global.Parse === 'undefined') throw new Error('global not set');
      console.log('ok');
    `;

    const out = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('ok');
  });
});
