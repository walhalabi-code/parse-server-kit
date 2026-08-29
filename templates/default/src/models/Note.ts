import {
  ParseClass,
  ParseField,
  BaseModel,
  BeforeSave,
  validateOrThrow,
  roleKey,
} from 'parse-server-kit';

/**
 * A note.
 *
 * Everything about the database comes from this one class: the schema, a unique
 * index on `slug`, a MongoDB validator enforcing the length and enum rules, the
 * class-level permissions, and the OpenAPI schema. There is no migration to
 * write and no separate DTO to keep in step.
 *
 * **Note the `declare` on every field.** `@ParseField` installs a getter and
 * setter on the prototype that read and write Parse's attribute store; the
 * field declaration is only there to give TypeScript the type. Written as
 * `title!: string`, TypeScript emits a real class field — an own property set
 * to `undefined` — which shadows that accessor. Reads then return `undefined`,
 * and worse, writes land on the own property instead of the store, so `save()`
 * sends nothing and no error is raised.
 *
 * `declare` tells TypeScript to emit no field at all, which is exactly right:
 * the storage is Parse's, not the instance's. It is correct under every
 * `target` and every `useDefineForClassFields` setting.
 */
@ParseClass('Note', {
  description: 'A short note',
  clp: {
    // Anyone signed in may read; only an Editor may change anything.
    find: {requiresAuthentication: true},
    get: {requiresAuthentication: true},
    count: {requiresAuthentication: true},
    create: {[roleKey('Editor')]: true},
    update: {[roleKey('Editor')]: true},
    delete: {[roleKey('Editor')]: true},
  },
  compoundIndexes: [{fields: ['status', 'createdAt']}],
})
export default class Note extends BaseModel {
  constructor() {
    super('Note');
  }

  @ParseField({type: 'String', required: true, minLength: 1, maxLength: 120})
  declare title: string;

  @ParseField({type: 'String', required: true, unique: true})
  declare slug: string;

  @ParseField({type: 'String', maxLength: 10000})
  declare body: string;

  @ParseField({
    type: 'String',
    enum: ['draft', 'published'],
    description: 'Only published notes are readable by the public',
  })
  declare status: string;

  @ParseField({type: 'Number', min: 0})
  declare views: number;

  @BeforeSave()
  static async onBeforeSave(req: Parse.Cloud.BeforeSaveRequest<Note>) {
    const note = req.object as Note;

    if (!note.status) note.status = 'draft';
    if (note.views === undefined) note.views = 0;

    // Derive the slug rather than trusting the caller with a unique field.
    if (!note.slug && note.title) {
      note.slug = note.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
    }

    // Checks the same rules declared above — required, minLength, maxLength,
    // enum, min — and throws a Parse VALIDATION_ERROR listing every failure.
    validateOrThrow(note);
  }
}

