/**
 * Models that exercise every feature the smoke suite checks.
 *
 * Deliberately one model per concern rather than one model with everything, so
 * a failure names the feature rather than "the big model broke".
 */
import {
  ParseClass,
  ParseField,
  BaseModel,
  ParseVersionField,
  BeforeSave,
  AfterSave,
  BeforeDelete,
  BeforeFind,
  validateOrThrow,
} from '../../src';

/** Counters the assertions read, to prove a trigger actually ran. */
export const triggerLog = {
  beforeSave: 0,
  afterSave: 0,
  beforeDelete: 0,
  beforeFind: 0,
};

/** Every field-level validation rule in one place. */
@ParseClass('SmokeWidget', {
  description: 'Field types, validation and indexes',
  clp: {
    find: {'*': true},
    get: {'*': true},
    count: {'*': true},
    create: {'*': true},
    update: {'*': true},
    delete: {'*': true},
  },
  compoundIndexes: [{fields: ['status', 'createdAt']}],
})
export class SmokeWidget extends BaseModel {
  constructor() {
    super('SmokeWidget');
  }

  @ParseField({type: 'String', required: true, minLength: 2, maxLength: 40})
  declare name: string;

  @ParseField({type: 'String', required: true, unique: true})
  declare sku: string;

  @ParseField({type: 'Number', min: 0, max: 1000})
  declare price: number;

  @ParseField({type: 'String', enum: ['draft', 'live', 'retired']})
  declare status: string;

  @ParseField({type: 'String', pattern: '^[a-z0-9-]+$'})
  declare slug: string;

  @ParseField({type: 'GeoPoint', geo: true})
  declare where: Parse.GeoPoint;

  @ParseField({type: 'Date'})
  declare availableFrom: Date;

  @BeforeSave()
  static async onBeforeSave(req: any) {
    triggerLog.beforeSave += 1;
    const w = req.object as SmokeWidget;
    if (!w.status) w.status = 'draft'; // default applied by the trigger
    validateOrThrow(w);
  }

  @AfterSave()
  static async onAfterSave() {
    triggerLog.afterSave += 1;
  }

  @BeforeDelete()
  static async onBeforeDelete() {
    triggerLog.beforeDelete += 1;
  }

  @BeforeFind()
  static async onBeforeFind() {
    triggerLog.beforeFind += 1;
  }
}

/** A pointer target, so fromParams has something real to point at. */
@ParseClass('SmokeTag', {
  clp: {find: {'*': true}, get: {'*': true}, create: {'*': true}, update: {'*': true}, delete: {'*': true}, count: {'*': true}},
})
export class SmokeTag extends BaseModel {
  constructor() {
    super('SmokeTag');
  }

  @ParseField({type: 'String', required: true})
  declare label: string;
}

/** Every conversion fromParams performs, and the ones it deliberately skips. */
@ParseClass('SmokeDoc', {
  clp: {find: {'*': true}, get: {'*': true}, create: {'*': true}, update: {'*': true}, delete: {'*': true}, count: {'*': true}},
})
export class SmokeDoc extends BaseModel {
  constructor() {
    super('SmokeDoc');
  }

  @ParseField({type: 'String'})
  declare title: string;

  @ParseField({type: 'Pointer', targetClass: 'SmokeTag'})
  declare tag: Parse.Object;

  @ParseField({type: 'Array', targetClass: 'SmokeTag'})
  declare tags: Parse.Object[];

  @ParseField({type: 'Date'})
  declare publishedAt: Date;

  @ParseField({type: 'GeoPoint'})
  declare spot: Parse.GeoPoint;

  // Excluded by default (EXCLUDED_POINTER_CLASSES): fromParams must skip it.
  @ParseField({type: 'Pointer', targetClass: 'IMG'})
  declare cover: Parse.Object;

  // No targetClass, so an array of ids must stay raw strings.
  @ParseField({type: 'Array'})
  declare rawList: unknown[];

  // Exercised by the file-upload tests, through the GridFS adapter.
  @ParseField({type: 'File'})
  declare attachment: Parse.File;
}

/** Stock, with a version field, for the concurrency test. */
@ParseClass('SmokeStock', {
  clp: {find: {'*': true}, get: {'*': true}, create: {'*': true}, update: {'*': true}, delete: {'*': true}, count: {'*': true}},
})
export class SmokeStock extends BaseModel {
  constructor() {
    super('SmokeStock');
  }

  @ParseField({type: 'String', required: true})
  declare name: string;

  @ParseField({type: 'Number', required: true, min: 0})
  declare units: number;

  @ParseVersionField()
  declare version: number;
}

/** Rows written inside a transaction, to prove commit and rollback. */
@ParseClass('SmokeLedger', {
  clp: {find: {'*': true}, get: {'*': true}, create: {'*': true}, update: {'*': true}, delete: {'*': true}, count: {'*': true}},
})
export class SmokeLedger extends BaseModel {
  constructor() {
    super('SmokeLedger');
  }

  @ParseField({type: 'String', required: true})
  declare note: string;
}

/** A trigger on a class with NO @ParseClass must never register. */
export class SmokeOrphan extends BaseModel {
  constructor() {
    super('SmokeOrphan');
  }

  @BeforeSave()
  static async never() {
    throw new Error('an orphaned trigger fired — it should never have registered');
  }
}
