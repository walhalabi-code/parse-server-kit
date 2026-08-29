import 'reflect-metadata';
import {configureKit, kitConfig, resetKitConfig} from '../src/config';
import {roleKey, UserRoles} from '../src/utils/constants';

/**
 * These settings replaced hardcoded values — a mount path read straight from
 * `process.env.mountPath`, an admin role called `SuperAdmin`, a pointer class
 * called `IMG`. All three came from one project's conventions.
 *
 * The property that matters is therefore not that they can be configured, but
 * that configuring nothing behaves exactly as before. Most of this file is
 * about the defaults.
 */

const originalMountPath = process.env.mountPath;

beforeEach(() => {
  resetKitConfig();
  delete process.env.mountPath;
});

afterAll(() => {
  resetKitConfig();
  if (originalMountPath === undefined) delete process.env.mountPath;
  else process.env.mountPath = originalMountPath;
});

describe('defaults reproduce the previous behaviour', () => {
  it('keeps the old admin role', () => {
    expect(kitConfig().adminRole).toBe('SuperAdmin');
  });

  it('keeps the old excluded pointer classes', () => {
    expect(kitConfig().excludedPointerClasses).toEqual(['IMG', 'File']);
  });

  it('still reads process.env.mountPath, as it always did', () => {
    process.env.mountPath = '/parse';
    expect(kitConfig().mountPath).toBe('/parse');
  });

  it('falls back to /parse when the environment says nothing', () => {
    // Previously this produced the string "undefined", which is not a path.
    expect(kitConfig().mountPath).toBe('/parse');
  });
});

describe('configureKit', () => {
  it('overrides a value', () => {
    configureKit({adminRole: 'Owner'});
    expect(kitConfig().adminRole).toBe('Owner');
  });

  it('takes precedence over the environment', () => {
    process.env.mountPath = '/from-env';
    configureKit({mountPath: '/explicit'});
    expect(kitConfig().mountPath).toBe('/explicit');
  });

  it('merges across calls rather than replacing', () => {
    configureKit({adminRole: 'Owner'});
    configureKit({mountPath: '/api'});
    expect(kitConfig()).toMatchObject({adminRole: 'Owner', mountPath: '/api'});
  });

  it('resolves at use, so it can be called after import', () => {
    const before = kitConfig().mountPath;
    configureKit({mountPath: '/late'});
    expect(before).toBe('/parse');
    expect(kitConfig().mountPath).toBe('/late');
  });

  it('hands out a copy of the array, not the shared default', () => {
    kitConfig().excludedPointerClasses.push('Mutated');
    expect(kitConfig().excludedPointerClasses).toEqual(['IMG', 'File']);
  });
});

describe('masterKey', () => {
  const originalMasterKey = process.env.masterKey;
  afterAll(() => {
    if (originalMasterKey === undefined) delete process.env.masterKey;
    else process.env.masterKey = originalMasterKey;
  });

  it('still reads process.env.masterKey, as it always did', () => {
    process.env.masterKey = 'from-env';
    expect(kitConfig().masterKey).toBe('from-env');
  });

  it('prefers an explicit value', () => {
    process.env.masterKey = 'from-env';
    configureKit({masterKey: 'explicit'});
    expect(kitConfig().masterKey).toBe('explicit');
  });

  it('is empty when nothing is configured — never a matchable default', () => {
    // An absent master key must never match. `restrictRoutes` treats empty as
    // "no bypass", so a misconfigured server fails closed rather than
    // admitting every caller as master.
    delete process.env.masterKey;
    expect(kitConfig().masterKey).toBe('');
  });
});

describe('roleKey', () => {
  it('works with a plain string — any project can use its own roles', () => {
    expect(roleKey('BusinessOwner')).toBe('role:BusinessOwner');
  });

  it('works with a caller-defined enum', () => {
    enum MyRoles {
      OWNER = 'Owner',
      MEMBER = 'Member',
    }
    expect(roleKey(MyRoles.OWNER)).toBe('role:Owner');
    expect(roleKey(MyRoles.MEMBER)).toBe('role:Member');
  });

  it('still accepts the deprecated built-in enum', () => {
    expect(roleKey(UserRoles.ADMIN)).toBe('role:SuperAdmin');
    expect(roleKey(UserRoles.EMPLOYEE)).toBe('role:Employee');
  });

  it('preserves the literal type', () => {
    // Compile-time assertion: the return must narrow to `role:Editor`,
    // not widen to `string`.
    const key: 'role:Editor' = roleKey('Editor');
    expect(key).toBe('role:Editor');
  });
});
