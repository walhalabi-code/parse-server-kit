import 'reflect-metadata';
import {ParseClass, ParseField} from '../src/decorators/parseDecorators';

/**
 * `@ParseClass` repairs class fields that shadow `@ParseField`'s accessors.
 *
 * The test suite compiles at `target: ES2020`, where TypeScript emits no such
 * field — so the failure cannot be reproduced by writing an ordinary model
 * here. That is precisely why it went unnoticed: no test in this repository
 * *could* have caught it.
 *
 * These tests therefore create the shadow by hand, exactly as TypeScript would
 * at `target: ES2022` (`useDefineForClassFields` on), and assert the repair.
 * The behaviour is also verified end to end against a real ES2022 build.
 */

/** What `title!: string` compiles to under `useDefineForClassFields`. */
function emitClassField(instance: object, name: string): void {
  Object.defineProperty(instance, name, {
    value: undefined,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

@ParseClass('ShadowDoc')
class ShadowDoc extends Parse.Object {
  constructor() {
    super('ShadowDoc');
    // Stand in for the field TypeScript would emit right here.
    emitClassField(this, 'title');
    emitClassField(this, 'count');
  }

  @ParseField({type: 'String'})
  declare title: string;

  @ParseField({type: 'Number'})
  declare count: number;
}

@ParseClass('CleanDoc')
class CleanDoc extends Parse.Object {
  constructor() {
    super('CleanDoc');
  }

  @ParseField({type: 'String'})
  declare title: string;
}

describe('a shadowing class field', () => {
  it('is removed, so writes reach Parse instead of the instance', () => {
    const doc = new ShadowDoc();
    doc.title = 'hello';

    // The property reads back either way; what matters is where it went.
    expect(doc.title).toBe('hello');
    expect(doc.get('title')).toBe('hello');
  });

  it('lets a write appear in what save() would send', () => {
    const doc = new ShadowDoc();
    doc.title = 'persisted';

    // Without the repair this object is empty on the wire — the exact silent
    // failure: no error, and the field simply never arrives.
    expect(Object.keys(doc.toJSON())).toContain('title');
  });

  it('is repaired for every declared field, not just the first', () => {
    const doc = new ShadowDoc();
    doc.title = 'a';
    doc.count = 7;

    expect(doc.get('title')).toBe('a');
    expect(doc.get('count')).toBe(7);
  });

  it('leaves no own data property behind to shadow again', () => {
    const doc = new ShadowDoc();
    const own = Object.getOwnPropertyDescriptor(doc, 'title');
    // Either gone entirely, or an accessor — never a plain value.
    expect(own?.value).toBeUndefined();
  });

  it('reads a value Parse loaded, rather than undefined', () => {
    const doc = new ShadowDoc();
    doc.set('title', 'from the database');
    expect(doc.title).toBe('from the database');
  });
});

describe('a class without the problem', () => {
  it('behaves exactly as before — the repair is a no-op', () => {
    const doc = new CleanDoc();
    doc.title = 'unchanged';

    expect(doc.title).toBe('unchanged');
    expect(doc.get('title')).toBe('unchanged');
    expect(Object.keys(doc.toJSON())).toContain('title');
  });
});

describe('what the wrapping must not disturb', () => {
  it('keeps the class name, which @Route derives its prefix from', () => {
    expect(ShadowDoc.name).toBe('ShadowDoc');
    expect(CleanDoc.name).toBe('CleanDoc');
  });

  it('keeps instanceof working', () => {
    expect(new ShadowDoc()).toBeInstanceOf(ShadowDoc);
    expect(new ShadowDoc()).toBeInstanceOf(Parse.Object);
  });

  it('keeps field metadata reachable through the subclass', () => {
    const fields = Reflect.getMetadata('parse:fields', ShadowDoc);
    expect(Object.keys(fields)).toEqual(expect.arrayContaining(['title', 'count']));
  });

  it('keeps the registered Parse subclass resolvable by class name', () => {
    expect((Parse.Object.extend('ShadowDoc') as any).name).toBe('ShadowDoc');
  });

  it('preserves an instance built by Parse from JSON', () => {
    const doc = Parse.Object.fromJSON(
      {className: 'ShadowDoc', objectId: 'abc', title: 'loaded'},
      true
    ) as ShadowDoc;

    expect(doc).toBeInstanceOf(ShadowDoc);
    expect(doc.title).toBe('loaded');
  });
});
