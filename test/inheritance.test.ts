import 'reflect-metadata';
import {ParseClass, ParseField, BaseModel} from '../src';
import {ParseVersionField} from '../src/database/versionRegistry';

/**
 * Decorator metadata and class inheritance.
 *
 * `Reflect.getMetadata` walks the prototype chain, so asking a subclass for its
 * field metadata returns the PARENT's object when the subclass has none of its
 * own yet. Mutating that object in place — rather than copying it first — makes
 * every class in the tree share one record.
 *
 * An audit base class is a normal thing to write:
 *
 *   class Auditable extends BaseModel { @ParseField() declare createdBy }
 *   class Product   extends Auditable { @ParseField() declare name }
 *   class Order     extends Auditable { @ParseField() declare total }
 *
 * If the metadata is shared, Product gets `total`, Order gets `name`, and
 * Auditable gets both — which means wrong schemas, `fromParams` converting
 * fields the model does not have, `validateOrThrow` demanding foreign required
 * fields, and `applyAllIndexes` indexing columns that do not exist.
 */

const fieldsOf = (target: unknown): string[] =>
  Object.keys((Reflect as any).getMetadata('parse:fields', target) || {});

@ParseClass('InhBase')
class InhBase extends BaseModel {
  constructor() {
    super('InhBase');
  }

  @ParseField({type: 'String'})
  declare sharedName: string;
}

@ParseClass('InhChildA')
class InhChildA extends InhBase {
  constructor() {
    super();
  }

  @ParseField({type: 'Number'})
  declare onlyA: number;
}

@ParseClass('InhChildB')
class InhChildB extends InhBase {
  constructor() {
    super();
  }

  @ParseField({type: 'Boolean'})
  declare onlyB: boolean;
}

describe('field metadata across an inheritance tree', () => {
  it('gives each class its own metadata object', () => {
    const base = (Reflect as any).getMetadata('parse:fields', InhBase);
    const a = (Reflect as any).getMetadata('parse:fields', InhChildA);
    const b = (Reflect as any).getMetadata('parse:fields', InhChildB);

    expect(a).not.toBe(base);
    expect(b).not.toBe(base);
    expect(a).not.toBe(b);
  });

  it('leaves the base class with only its own fields', () => {
    expect(fieldsOf(InhBase).sort()).toEqual(['sharedName']);
  });

  it('gives a subclass its own fields plus the inherited ones', () => {
    expect(fieldsOf(InhChildA).sort()).toEqual(['onlyA', 'sharedName']);
  });

  it('does not leak one subclass into its sibling', () => {
    // The failure this whole file exists for.
    expect(fieldsOf(InhChildB)).not.toContain('onlyA');
    expect(fieldsOf(InhChildA)).not.toContain('onlyB');
  });

  it('inherits the parent field definition, not just its name', () => {
    const a: any = (Reflect as any).getMetadata('parse:fields', InhChildA);
    expect(a.sharedName?.type).toBe('String');
    expect(a.onlyA?.type).toBe('Number');
  });
});

describe('a subclass that adds no fields of its own', () => {
  @ParseClass('InhPlain')
  class InhPlain extends InhBase {
    constructor() {
      super();
    }
  }

  it('still reports the inherited fields', () => {
    // Nothing wrote metadata for this class, so the prototype-chain lookup is
    // doing the work here — which is the behaviour worth keeping.
    expect(fieldsOf(InhPlain)).toContain('sharedName');
  });
});

describe('version fields across inheritance', () => {
  @ParseClass('InhVersionedBase')
  class InhVersionedBase extends BaseModel {
    constructor() {
      super('InhVersionedBase');
    }

    @ParseVersionField()
    declare version: number;
  }

  @ParseClass('InhVersionedChild')
  class InhVersionedChild extends InhVersionedBase {
    constructor() {
      super();
    }

    @ParseField({type: 'String'})
    declare label: string;
  }

  it('does not put the child field on the parent', () => {
    expect(fieldsOf(InhVersionedBase)).not.toContain('label');
  });
});
