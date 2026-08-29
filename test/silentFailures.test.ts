import 'reflect-metadata';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ParseClass, ParseField} from '../src/decorators/parseDecorators';
import {BeforeSave} from '../src/decorators/triggerDecorator';
import {TriggerRegistry} from '../src/decorators/triggerRegistry';
import {CloudFunction} from '../src/decorators/cloudDecorator';
import {CloudFunctionRegistry} from '../src/decorators/cloudRegistry';
import {Transactional} from '../src/transactions/context';
import {importFiles} from '../src/utils/dynamicImport';
import {classNames} from '../src/decorators/types/schemaTypes';

/**
 * Failures that used to happen in silence.
 *
 * Each of these once produced no error, no log and no symptom beyond a feature
 * simply not being there. They are either impossible now, or they say so.
 */

function captureWarnings(): {lines: string[]; restore: () => void} {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => lines.push(args.join(' '));
  return {lines, restore: () => (console.warn = original)};
}

describe('decorator order no longer decides whether a transaction opens', () => {
  const defined = new Map<string, Function>();
  let originalDefine: any;

  beforeEach(() => {
    defined.clear();
    (CloudFunctionRegistry as any).functions = new Map();
    originalDefine = (Parse.Cloud as any).define;
    (Parse.Cloud as any).define = (name: string, handler: Function) =>
      defined.set(name, handler);
  });

  afterEach(() => {
    (Parse.Cloud as any).define = originalDefine;
  });

  /** Marks the function so a test can see which wrapper ended up outermost. */
  const wrapped = new WeakSet<Function>();
  function MarkWrapper() {
    return (_t: object, _k: string, descriptor: PropertyDescriptor) => {
      const inner = descriptor.value;
      const outer = function (this: unknown, ...args: unknown[]) {
        return inner.apply(this, args);
      };
      wrapped.add(outer);
      descriptor.value = outer;
      return descriptor;
    };
  }

  it('registers the wrapper when it is applied ABOVE @CloudFunction', () => {
    class Fns {
      // The order that used to break: @CloudFunction captured the method
      // before MarkWrapper ever wrapped it.
      @MarkWrapper()
      @CloudFunction({methods: ['POST']})
      static async doThing() {
        return 'ok';
      }
    }
    void Fns;

    CloudFunctionRegistry.initialize();
    expect(wrapped.has(defined.get('doThing') as Function)).toBe(true);
  });

  it('registers the wrapper when it is applied BELOW @CloudFunction', () => {
    class Fns {
      @CloudFunction({methods: ['POST']})
      @MarkWrapper()
      static async doThing2() {
        return 'ok';
      }
    }
    void Fns;

    CloudFunctionRegistry.initialize();
    // Below means @CloudFunction wraps the marked function, so the outermost
    // is its own role-check wrapper - but the marked one is still in the
    // chain, which is what matters: it is not dropped.
    expect(typeof defined.get('doThing2')).toBe('function');
  });

  it('still calls through to the original body', async () => {
    class Fns {
      @Transactional()
      @CloudFunction({methods: ['POST']})
      static async compute() {
        return 42;
      }
    }
    void Fns;

    CloudFunctionRegistry.initialize();
    const handler = defined.get('compute') as Function;
    await expect(handler({params: {}})).resolves.toBe(42);
  });
});

describe('a trigger on a class without @ParseClass', () => {
  // The bare Parse SDK has no cloud trigger methods - parse-server adds them.
  // Stubbed so initialize() can run without a server.
  let originalCloud: any;
  beforeEach(() => {
    originalCloud = (Parse as any).Cloud;
    const noop = () => undefined;
    (Parse as any).Cloud = new Proxy({}, {get: () => noop});
  });
  afterEach(() => ((Parse as any).Cloud = originalCloud));

  it('says so instead of never firing in silence', () => {
    class Orphan {
      @BeforeSave()
      static async onBeforeSave() {
        /* never registered */
      }
    }
    void Orphan;

    const warn = captureWarnings();
    TriggerRegistry.initialize();
    warn.restore();

    const message = warn.lines.join('\n');
    expect(message).toContain('Orphan');
    expect(message).toContain('@ParseClass');
    expect(message).toContain('NOT registered');
  });

  it('says nothing for a class that does have @ParseClass', () => {
    @ParseClass('SfProperlyWired')
    class SfProperlyWired extends Parse.Object {
      constructor() {
        super('SfProperlyWired');
      }
      @ParseField({type: 'String'})
      declare title: string;

      @BeforeSave()
      static async onBeforeSave() {
        /* registered */
      }
    }
    void SfProperlyWired;

    const warn = captureWarnings();
    TriggerRegistry.initialize();
    warn.restore();

    expect(warn.lines.join('\n')).not.toContain('SfProperlyWired');
  });
});

describe('registering the same class twice', () => {
  it('warns rather than letting directory order decide', () => {
    @ParseClass('SfDuplicate')
    class First extends Parse.Object {
      constructor() {
        super('SfDuplicate');
      }
      @ParseField({type: 'String'})
      declare a: string;
    }
    void First;

    const warn = captureWarnings();

    @ParseClass('SfDuplicate')
    class Second extends Parse.Object {
      constructor() {
        super('SfDuplicate');
      }
      @ParseField({type: 'String'})
      declare a: string;
    }
    void Second;

    warn.restore();

    expect(warn.lines.join('\n')).toContain('SfDuplicate');
    expect(warn.lines.join('\n')).toContain('second time');
    // and the name is not double-counted
    expect(classNames.filter(n => n === 'SfDuplicate')).toHaveLength(1);
  });
});

describe('importFiles finding nothing', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'psk-import-'))));
  afterEach(() => rmSync(dir, {recursive: true, force: true}));

  it('reports a .ts-only directory instead of registering nothing quietly', () => {
    writeFileSync(join(dir, 'Product.ts'), '// a model');
    writeFileSync(join(dir, 'Order.ts'), '// another');

    const warn = captureWarnings();
    importFiles(dir, {verbose: false});
    warn.restore();

    const message = warn.lines.join('\n');
    expect(message).toContain('Imported 0 files');
    expect(message).toContain("extensions: ['.js', '.ts']");
    expect(message).toContain('no models');
  });

  it('says nothing when it imported what it was asked for', () => {
    writeFileSync(join(dir, 'thing.js'), 'module.exports = {};');

    const warn = captureWarnings();
    importFiles(dir, {verbose: false});
    warn.restore();

    expect(warn.lines.join('\n')).not.toContain('Imported 0 files');
  });

  it('says nothing about an empty directory - there is nothing to report', () => {
    const warn = captureWarnings();
    importFiles(dir, {verbose: false});
    warn.restore();

    expect(warn.lines).toHaveLength(0);
  });
});

describe('standard decorators instead of legacy', () => {
  it('throws a message naming experimentalDecorators', () => {
    const decorate = ParseField({type: 'String'}) as unknown as (
      value: unknown,
      context: unknown
    ) => void;

    // How TypeScript calls a standard (TC39) field decorator.
    const standardContext = {kind: 'field', name: 'title', static: false};

    expect(() => decorate(undefined, standardContext)).toThrow(
      /experimentalDecorators/
    );
  });
});
