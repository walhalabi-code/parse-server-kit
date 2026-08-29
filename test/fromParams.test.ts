import 'reflect-metadata';
import {ParseClass, ParseField} from '../src/decorators/parseDecorators';
import {BaseModel} from '../src/models/BaseModel';

/**
 * `BaseModel.fromParams()` — the conversion layer between a request body and a
 * typed Parse object.
 *
 * The behaviour worth pinning is what it does with input nobody declared,
 * because that decides whether it is a convenience or a safety feature.
 */

@ParseClass('FpProduct')
class FpProduct extends BaseModel {
  constructor() {
    super('FpProduct');
  }

  @ParseField({type: 'String'})
  declare name: string;

  @ParseField({type: 'Number'})
  declare price: number;

  @ParseField({type: 'Date'})
  declare releasedAt: Date;

  @ParseField({type: 'Object'})
  declare meta: Record<string, unknown>;

  @ParseField({type: 'Pointer', targetClass: 'FpCategory'})
  declare category: any;

  @ParseField({type: 'Array', targetClass: 'FpTag'})
  declare tags: any[];

  @ParseField({type: 'Array'})
  declare plainList: unknown[];

  @ParseField({type: 'Pointer', targetClass: 'IMG'})
  declare cover: any;
}

@ParseClass('FpCategory')
class FpCategory extends BaseModel {
  constructor() {
    super('FpCategory');
  }
  @ParseField({type: 'String'})
  declare title: string;
}
void FpCategory;

describe('scalars and shapes', () => {
  it('copies declared scalar fields', () => {
    const p = FpProduct.fromParams({name: 'Widget', price: 12});
    expect(p.get('name')).toBe('Widget');
    expect(p.get('price')).toBe(12);
  });

  it('converts a Date field from a string', () => {
    const p = FpProduct.fromParams({releasedAt: '2026-03-01T00:00:00.000Z'});
    const value = p.get('releasedAt');
    expect(value).toBeInstanceOf(Date);
    expect((value as Date).getUTCFullYear()).toBe(2026);
  });

  it('passes an Object field through untouched', () => {
    const meta = {colour: 'red', dims: {w: 2}};
    const p = FpProduct.fromParams({meta});
    expect(p.get('meta')).toEqual(meta);
  });

  it('ignores a declared field that was not sent', () => {
    const p = FpProduct.fromParams({name: 'Only name'});
    expect(p.get('price')).toBeUndefined();
  });
});

describe('pointers', () => {
  it('builds a pointer from {objectId}', () => {
    const p = FpProduct.fromParams({category: {objectId: 'cat123'}});
    const ref = p.get('category');
    expect(ref.id).toBe('cat123');
    expect(ref.className).toBe('FpCategory');
  });

  it('accepts {id} as well as {objectId}', () => {
    const p = FpProduct.fromParams({category: {id: 'cat456'}});
    expect(p.get('category').id).toBe('cat456');
  });

  it('builds a pointer from a bare id string', () => {
    // What a browser actually sends for a select field. This used to fall
    // through every branch and produce a pointer with `id: undefined` — an
    // object that looks right, saves without complaint, and matches no query
    // ever.
    const p = FpProduct.fromParams({category: 'cat789'});
    const ref = p.get('category');
    expect(ref.id).toBe('cat789');
    expect(ref.className).toBe('FpCategory');
  });

  it('builds an array of pointers from bare id strings', () => {
    const p = FpProduct.fromParams({tags: ['t1', 't2']});
    const tags = p.get('tags');
    expect(tags).toHaveLength(2);
    expect(tags[0].className).toBe('FpTag');
    expect(tags.map((t: any) => t.id)).toEqual(['t1', 't2']);
  });

  it('accepts Parse\'s own pointer JSON', () => {
    const p = FpProduct.fromParams({
      category: {__type: 'Pointer', className: 'FpCategory', objectId: 'cat999'},
    });
    expect(p.get('category').id).toBe('cat999');
  });

  it('throws rather than building a pointer with no id', () => {
    // The whole point: refuse loudly instead of producing something broken.
    // `{}` and `null` are separate cases — those mean "clear it" — so anything
    // reaching here genuinely has no id to use.
    expect(() => FpProduct.fromParams({category: {name: 'no id here'}})).toThrow(
      /expected an id string/
    );
    expect(() => FpProduct.fromParams({category: 123})).toThrow(/expected an id string/);
    expect(() => FpProduct.fromParams({category: ''})).toThrow(/expected an id string/);
  });

  it('names the field and target class when it throws', () => {
    // A message that says which field was wrong is the difference between a
    // one-minute fix and a bisect.
    expect(() => FpProduct.fromParams({category: 42})).toThrow(/category/);
    expect(() => FpProduct.fromParams({category: 42})).toThrow(/FpCategory/);
  });

  it('throws for a bad entry inside an array of pointers', () => {
    expect(() => FpProduct.fromParams({tags: ['ok', {no: 'id'}]})).toThrow(
      /expected an id string/
    );
  });

  it('treats null as an explicit clear', () => {
    const p = FpProduct.fromParams({category: null});
    expect(p.get('category')).toBeNull();
  });

  it('treats {} as an explicit clear too', () => {
    const p = FpProduct.fromParams({category: {}});
    expect(p.get('category')).toBeNull();
  });

  it('converts an array of pointers when targetClass is declared', () => {
    const p = FpProduct.fromParams({
      tags: [{objectId: 't1'}, {objectId: 't2'}],
    });
    const tags = p.get('tags');
    expect(tags).toHaveLength(2);
    expect(tags[0].className).toBe('FpTag');
    expect(tags.map((t: any) => t.id)).toEqual(['t1', 't2']);
  });

  it('leaves an Array without targetClass exactly as sent', () => {
    // Documented behaviour: no targetClass means no pointer conversion.
    const p = FpProduct.fromParams({plainList: [{objectId: 'x'}, 'plain']});
    expect(p.get('plainList')).toEqual([{objectId: 'x'}, 'plain']);
  });

  it('never writes an excluded pointer class', () => {
    // IMG is excluded by default: an uploaded file must be saved and processed
    // before it can be attached, so a pointer built from raw params would
    // reference nothing. Skipping the conversion means the field is never
    // marked dirty, so nothing is written for it.
    const p = FpProduct.fromParams({name: 'x', cover: {objectId: 'img1'}});

    const payload = (p as unknown as {_getSaveJSON(): Record<string, unknown>})
      ._getSaveJSON();

    expect(payload).toHaveProperty('name');
    expect(payload).not.toHaveProperty('cover');
  });
});

describe('create versus update', () => {
  it('has no id when none was sent', () => {
    const p = FpProduct.fromParams({name: 'New'});
    expect(p.id).toBeUndefined();
  });

  it('carries an id through, so the same call updates', () => {
    const p = FpProduct.fromParams({id: 'prod789', name: 'Edited'});
    expect(p.id).toBe('prod789');
    expect(p.get('name')).toBe('Edited');
  });
});

describe('undeclared input', () => {
  it('does NOT copy an undeclared key into a declared field', () => {
    const p = FpProduct.fromParams({name: 'ok', isAdmin: true});
    expect(p.get('name')).toBe('ok');
  });

  it('never persists an undeclared key, whatever the caller sends', () => {
    // The property that matters, and the one that makes fromParams safe to
    // point at a raw request body.
    //
    // `Parse.Object.fromJSON` seeds the object with the whole payload but
    // marks those values CLEAN — as if they had been fetched. Only the fields
    // the conversion loop explicitly set() become dirty, and save() sends
    // dirty fields only. So undeclared input is visible in memory and is never
    // written.
    const p = FpProduct.fromParams({name: 'ok', isAdmin: true, role: 'root'});

    const payload = (p as unknown as {_getSaveJSON(): Record<string, unknown>})
      ._getSaveJSON();

    expect(payload).toHaveProperty('name', 'ok');
    expect(payload).not.toHaveProperty('isAdmin');
    expect(payload).not.toHaveProperty('role');
  });

  it('leaves undeclared input readable in memory, though — triggers can see it', () => {
    // Worth knowing: a @BeforeSave doing req.object.get('isAdmin') would read
    // caller input, even though it is never stored.
    const p = FpProduct.fromParams({name: 'ok', isAdmin: true});
    expect(p.get('isAdmin')).toBe(true);
  });

  it('leaves the params object it was given untouched', () => {
    // `className` is needed for Parse.Object.fromJSON to accept the input, but
    // it goes on a copy. Writing it into `req.params` meant a second call — a
    // retried transaction, say — saw an input the first call had altered.
    const params: Record<string, unknown> = {name: 'x'};
    const product = FpProduct.fromParams(params);

    expect(params).toEqual({name: 'x'});
    expect(params.className).toBeUndefined();
    // ...and the object still came out right.
    expect(product.get('name')).toBe('x');
  });
});
