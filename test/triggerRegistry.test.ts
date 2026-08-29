import 'reflect-metadata';
import {TriggerRegistry} from '../src/decorators/triggerRegistry';
import {TriggerType} from '../src/decorators/types/triggerTypes';

/**
 * How a declared trigger reaches parse-server.
 *
 * The reason this file exists: parse-server used to expose a method per file
 * trigger — `Parse.Cloud.beforeSaveFile` and friends — and removed them in
 * favour of passing the class itself to `beforeSave`. The kit went on calling
 * the old names, so `@BeforeSaveFile` died with `TypeError: not a function` the
 * moment `TriggerRegistry.initialize()` ran. Nothing caught it, because nothing
 * tested it.
 *
 * These tests assert the *dispatch*: which `Parse.Cloud` method is called, and
 * what it is handed. They deliberately do not touch parse-server itself.
 */

type Call = {method: string; args: unknown[]};

/** Record every Parse.Cloud call instead of registering anything for real. */
function captureCloudCalls(): {calls: Call[]; restore: () => void} {
  const calls: Call[] = [];
  const original = (Parse as any).Cloud;

  const methods = [
    'beforeSave', 'afterSave', 'beforeDelete', 'afterDelete',
    'beforeFind', 'afterFind',
    'beforeLogin', 'afterLogin', 'afterLogout', 'beforePasswordResetRequest',
    'beforeConnect', 'beforeSubscribe', 'afterLiveQueryEvent',
  ];

  const stub: Record<string, unknown> = {};
  for (const method of methods) {
    stub[method] = (...args: unknown[]) => calls.push({method, args});
  }
  (Parse as any).Cloud = stub;

  // Parse.File/Parse.Config are what the class-argument form passes through.
  (Parse as any).Config = (Parse as any).Config ?? function Config() {};

  return {calls, restore: () => ((Parse as any).Cloud = original)};
}

/** TriggerRegistry keeps one static map; each test needs a clean one. */
function resetRegistry(): void {
  (TriggerRegistry as any).triggers = new Map();
}

function register(type: TriggerType, className = 'Thing'): void {
  TriggerRegistry.register({
    type,
    className,
    handler: function handler() {},
  });
}

describe('TriggerRegistry dispatch', () => {
  let captured: {calls: Call[]; restore: () => void};

  beforeEach(() => {
    resetRegistry();
    captured = captureCloudCalls();
  });

  afterEach(() => captured.restore());

  it('registers an ordinary class trigger by class name', () => {
    register('beforeSave', 'Product');
    TriggerRegistry.initialize();

    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].method).toBe('beforeSave');
    expect(captured.calls[0].args[0]).toBe('Product');
  });

  describe('file triggers use the class-argument form', () => {
    // The regression this file was written for.
    const cases: Array<[TriggerType, string]> = [
      ['beforeSaveFile', 'beforeSave'],
      ['afterSaveFile', 'afterSave'],
      ['beforeDeleteFile', 'beforeDelete'],
      ['afterDeleteFile', 'afterDelete'],
      ['beforeFindFile', 'beforeFind'],
      ['afterFindFile', 'afterFind'],
    ];

    it.each(cases)('%s → Parse.Cloud.%s(Parse.File, ...)', (type, method) => {
      register(type);
      TriggerRegistry.initialize();

      expect(captured.calls).toHaveLength(1);
      expect(captured.calls[0].method).toBe(method);
      // Parse.File itself, NOT the class name it was declared on.
      expect(captured.calls[0].args[0]).toBe(Parse.File);
    });

    it('never calls the removed beforeSaveFile-style methods', () => {
      for (const [type] of cases) register(type, `C${type}`);
      TriggerRegistry.initialize();

      const called = captured.calls.map(c => c.method);
      expect(called).not.toContain('beforeSaveFile');
      expect(called).not.toContain('afterSaveFile');
      expect(called).not.toContain('beforeDeleteFile');
      expect(called).not.toContain('afterDeleteFile');
    });
  });

  describe('config triggers use the class-argument form', () => {
    it.each([
      ['beforeSaveConfig', 'beforeSave'],
      ['afterSaveConfig', 'afterSave'],
    ] as Array<[TriggerType, string]>)('%s → Parse.Cloud.%s(Parse.Config, ...)', (type, method) => {
      register(type);
      TriggerRegistry.initialize();

      expect(captured.calls[0].method).toBe(method);
      expect(captured.calls[0].args[0]).toBe((Parse as any).Config);
    });
  });

  it('registers beforePasswordResetRequest without a class', () => {
    register('beforePasswordResetRequest');
    TriggerRegistry.initialize();

    expect(captured.calls[0].method).toBe('beforePasswordResetRequest');
    // Handler first — this trigger has no class to scope it to.
    expect(typeof captured.calls[0].args[0]).toBe('function');
  });

  it('maps afterEvent onto afterLiveQueryEvent', () => {
    register('afterEvent', 'Product');
    TriggerRegistry.initialize();

    expect(captured.calls[0].method).toBe('afterLiveQueryEvent');
    expect(captured.calls[0].args[0]).toBe('Product');
  });

  it('keeps one trigger per class+type, warning on the overwrite', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    register('beforeSave', 'Product');
    register('beforeSave', 'Product');

    expect(TriggerRegistry.getTriggers()).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
