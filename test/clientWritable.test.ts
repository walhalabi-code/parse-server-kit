import 'reflect-metadata';
import {ParseClass, ParseField} from '../src/decorators/parseDecorators';
import {BaseModel} from '../src/models/BaseModel';

/**
 * Mass assignment through `fromParams`.
 *
 * `fromParams` reads the model's field metadata and sets whatever the request
 * carried. Every declared field was therefore settable by any caller reaching
 * an endpoint that used it — including fields the server owns, like a counter
 * or a status a workflow is supposed to control.
 *
 * The failure has no symptom: the request succeeds, the row saves, and the only
 * evidence is data nobody meant to write.
 */

@ParseClass('MassAssign')
class MassAssign extends BaseModel {
  constructor() {
    super('MassAssign');
  }

  @ParseField({type: 'String'})
  declare title: string;

  @ParseField({type: 'String', clientWritable: false})
  declare status: string;

  @ParseField({type: 'Number', clientWritable: false})
  declare views: number;
}

describe('clientWritable', () => {
  it('takes the fields a client is allowed to set', () => {
    const row = MassAssign.fromParams({title: 'Hello'});
    expect(row.get('title')).toBe('Hello');
  });

  it('ignores a field marked clientWritable: false', () => {
    const row = MassAssign.fromParams({title: 'Hello', status: 'published'});

    expect(row.get('title')).toBe('Hello');
    expect(row.get('status')).toBeUndefined();
  });

  it('ignores every protected field, not merely the first', () => {
    const row = MassAssign.fromParams({
      title: 'Hello',
      status: 'published',
      views: 9999,
    });

    expect(row.get('status')).toBeUndefined();
    expect(row.get('views')).toBeUndefined();
  });

  it('does not send a protected field in what save() would write', () => {
    const row = MassAssign.fromParams({title: 'Hello', views: 9999});

    // The payload is what matters: a field absent here never reaches Parse.
    const payload = Object.keys(row.toJSON());
    expect(payload).toContain('title');
    expect(payload).not.toContain('views');
  });

  it('leaves your own code free to set the field', () => {
    // The restriction governs fromParams, not the field. Server code that
    // means to write it simply does.
    const row = MassAssign.fromParams({title: 'Hello'});
    row.set('views', 1);

    expect(row.get('views')).toBe(1);
    expect(Object.keys(row.toJSON())).toContain('views');
  });

  it('treats an unmarked field as writable, so nothing existing changes', () => {
    const row = MassAssign.fromParams({title: 'Still works'});
    expect(row.get('title')).toBe('Still works');
  });

  it('does not write `clientWritable: true` into the metadata', () => {
    // Absent means writable. Storing the default would bloat every field's
    // metadata and change the schema output for no reason.
    const fields = Reflect.getMetadata('parse:fields', MassAssign);
    expect('clientWritable' in fields.title).toBe(false);
    expect(fields.status.clientWritable).toBe(false);
  });
});

describe('the development warning', () => {
  const env = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = env; jest.restoreAllMocks(); });

  it('is silent in production, so it cannot leak which fields are protected', () => {
    process.env.NODE_ENV = 'production';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    MassAssign.fromParams({title: 'x', status: 'published'});
    expect(warn).not.toHaveBeenCalled();
  });
});