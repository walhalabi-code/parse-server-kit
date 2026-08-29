import 'reflect-metadata';
import {ParseClass, ParseField} from '../src/decorators/parseDecorators';
import {ParseVersionField, VersionRegistry} from '../src/database/versionRegistry';

/**
 * `@ParseVersionField` — the declaration side of optimistic locking.
 *
 * Runs against the real `parse` SDK so `_getSaveJSON`, `fromJSON` and
 * subclass registration behave exactly as they will under parse-server.
 */

@ParseClass('VRJob')
class VRJob extends Parse.Object {
  constructor() {
    super('VRJob');
  }

  @ParseVersionField()
  version!: number;

  @ParseField({type: 'String'})
  name!: string;
}

@ParseClass('VRCustomField')
class VRCustomField extends Parse.Object {
  constructor() {
    super('VRCustomField');
  }

  @ParseVersionField({description: 'my own words'})
  rev!: number;
}

@ParseClass('VRPlain')
class VRPlain extends Parse.Object {
  constructor() {
    super('VRPlain');
  }

  @ParseField({type: 'String'})
  title!: string;
}

describe('VersionRegistry', () => {
  it('records the class and its field once @ParseClass names it', () => {
    expect(VersionRegistry.isVersioned('VRJob')).toBe(true);
    expect(VersionRegistry.fieldFor('VRJob')).toBe('version');
  });

  it('supports any field name, not just "version"', () => {
    expect(VersionRegistry.fieldFor('VRCustomField')).toBe('rev');
  });

  it('does not register classes without a version field', () => {
    expect(VersionRegistry.isVersioned('VRPlain')).toBe(false);
    expect(VersionRegistry.fieldFor('VRPlain')).toBeUndefined();
  });

  it('lists every versioned class', () => {
    const names = VersionRegistry.classNames();
    expect(names).toContain('VRJob');
    expect(names).toContain('VRCustomField');
    expect(names).not.toContain('VRPlain');
  });
});

describe('@ParseVersionField schema declaration', () => {
  it('declares an optional Number field via @ParseField', () => {
    const fields = Reflect.getMetadata('parse:fields', VRJob);
    expect(fields.version).toMatchObject({type: 'Number', required: false});
  });

  it('carries a default description, overridable', () => {
    const jobFields = Reflect.getMetadata('parse:fields', VRJob);
    expect(jobFields.version.description).toMatch(/Incremented on every update/);

    const customFields = Reflect.getMetadata('parse:fields', VRCustomField);
    expect(customFields.rev.description).toBe('my own words');
  });
});

describe('version assertion on save (_getSaveJSON hook)', () => {
  /** An object as a query would hand it back: clean attributes, with an id. */
  function readFromDatabase(attributes: Record<string, unknown>): VRJob {
    return Parse.Object.fromJSON(
      {className: 'VRJob', ...attributes},
      true
    ) as VRJob;
  }

  function saveBodyOf(object: Parse.Object): Record<string, unknown> {
    return (object as unknown as {_getSaveJSON(): Record<string, unknown>})._getSaveJSON();
  }

  it('adds the version it was read at to the save payload, unasked', () => {
    const job = readFromDatabase({objectId: 'abc1', version: 4, name: 'old'});
    job.set('name', 'new');

    const body = saveBodyOf(job);
    expect(body.name).toBe('new');
    expect(body.version).toBe(4);
  });

  it('asserts the version even when nothing else changed', () => {
    const job = readFromDatabase({objectId: 'abc2', version: 9, name: 'x'});
    expect(saveBodyOf(job).version).toBe(9);
  });

  it('does not mark the object dirty by asserting', () => {
    const job = readFromDatabase({objectId: 'abc3', version: 2, name: 'x'});
    saveBodyOf(job);
    expect((job as unknown as {dirty(): boolean}).dirty()).toBe(false);
  });

  it('asserts nothing on a create — there is no version to assert', () => {
    const job = new VRJob();
    job.set('name', 'fresh');

    const body = saveBodyOf(job);
    expect(body.name).toBe('fresh');
    expect(body).not.toHaveProperty('version');
  });

  it('asserts nothing when the object was built from an id, never read', () => {
    const job = readFromDatabase({objectId: 'abc4', name: 'x'}); // no version
    job.set('name', 'y');

    expect(saveBodyOf(job)).not.toHaveProperty('version');
  });

  it('leaves a version the caller set dirty on purpose alone', () => {
    const job = readFromDatabase({objectId: 'abc5', version: 3, name: 'x'});
    job.set('version', 7);

    // The caller's explicit write is the value read back at save time.
    expect(saveBodyOf(job).version).toBe(7);
  });
});
