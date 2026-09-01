import 'reflect-metadata';
import {
  ClassAclTemplate,
  classLevelPermissions,
  classNames,
  ClassNameType,
  CLPParamsOption,
  CompoundIndex,
  ProtectedFields,
} from './types/schemaTypes';
import {SwaggerRegistry} from '../swagger/swaggerRegistry';
import type {SwaggerPropertySchema, SwaggerModelSchema} from '../swagger/swaggerRegistry';
import {TriggerRegistry} from './triggerRegistry';
import {markTriggersFlushed} from './triggerDecorator';

// ── Hooks for optional integrations (Swagger, Triggers — added in later versions) ──

type OnClassRegistered = (className: string, constructor: Function, fields: Record<string, any>, options: ParseClassOptions) => void;
type OnFieldRegistered = (constructor: Function, fieldName: string, fieldMeta: Record<string, any>) => void;

const classHooks: OnClassRegistered[] = [];
const fieldHooks: OnFieldRegistered[] = [];

/** Register a hook that runs when @ParseClass is applied. Used by Swagger, Triggers, etc. */
export function onClassRegistered(hook: OnClassRegistered) {
  classHooks.push(hook);
}

/** Register a hook that runs when @ParseField is applied. Used by Swagger, etc. */
export function onFieldRegistered(hook: OnFieldRegistered) {
  fieldHooks.push(hook);
}

// ── Field Types ──

const VALID_TYPES = new Set([
  'String', 'Number', 'Boolean', 'Date', 'Object', 'Array',
  'GeoPoint', 'File', 'Bytes', 'Polygon', 'Pointer', 'Relation',
]);

export type AllowedFieldType =
  | {type: 'String'; required?: boolean}
  | {type: 'Number'; required?: boolean}
  | {type: 'Boolean'; required?: boolean}
  | {type: 'Date'; required?: boolean}
  | {type: 'Object'; required?: boolean}
  | {type: 'Array'; required?: boolean}
  | {type: 'GeoPoint'; required?: boolean}
  | {type: 'File'; required?: boolean}
  | {type: 'Bytes'; required?: boolean}
  | {type: 'Polygon'; required?: boolean}
  | {type: 'Pointer'; targetClass: string; required: boolean}
  | {type: 'Relation'; targetClass: string; required: boolean};

/** Base options for ParseField */
interface ParseFieldBaseOptions {
  type: AllowedFieldType['type'];
  required?: boolean;
  targetClass?: ClassNameType;
  description?: string;
  indexName?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  enum?: string[];
  pattern?: string;
  /** Create a 2dsphere geo index on this field. Only valid for GeoPoint. */
  geo?: boolean;
  /** Create a TTL index that expires documents N seconds after this Date field. Only valid for Date. */
  ttlSeconds?: number;
  /**
   * Whether a client may set this field through `Model.fromParams()`.
   * Defaults to `true`.
   *
   * `fromParams` builds an object from request parameters, and by default it
   * will set **any** field declared on the model. That is convenient and it is
   * also mass assignment: an endpoint that does
   *
   * ```ts
   * const note = Note.fromParams(req.params);
   * ```
   *
   * accepts `{"title": "…", "status": "published", "views": 9999}` just as
   * readily as it accepts a title. Nothing is thrown and nothing is logged —
   * the row simply saves with values the caller was never meant to choose.
   *
   * Mark server-owned fields `clientWritable: false` and `fromParams` ignores
   * them, whatever the request contains. Your own code is unaffected: this
   * governs one function, not the field. Set it directly when you mean to:
   *
   * ```ts
   * @ParseField({type: 'Number', clientWritable: false}) declare views: number;
   *
   * note.views += 1;              // fine — this is your code
   * Note.fromParams(req.params);  // `views` in the body is discarded
   * ```
   *
   * Parse's own `protectedFields` is the mirror of this and does not replace
   * it: that hides fields on the way **out**, this refuses them on the way in.
   */
  clientWritable?: boolean;
}

interface ParseFieldWithIndex extends ParseFieldBaseOptions {
  index?: boolean | 1 | -1;
  unique?: never;
}

interface ParseFieldWithUnique extends ParseFieldBaseOptions {
  index?: never;
  unique?: boolean;
}

interface ParseFieldNoIndex extends ParseFieldBaseOptions {
  index?: never;
  unique?: never;
}

export type ParseFieldOptions =
  | ParseFieldWithIndex
  | ParseFieldWithUnique
  | ParseFieldNoIndex;

// ── @ParseField Decorator ──

export function ParseField(options: ParseFieldOptions) {
  const {
    type, required = false, targetClass, description, indexName,
    min, max, minLength, maxLength, geo, ttlSeconds, clientWritable,
  } = options;
  const enumValues = 'enum' in options ? options.enum : undefined;
  const pattern = 'pattern' in options ? options.pattern : undefined;
  const index = 'index' in options ? options.index : undefined;
  const unique = 'unique' in options ? options.unique : undefined;

  // Validations
  if (!VALID_TYPES.has(type)) {
    throw new Error(`Invalid field type: ${type}. Must be one of ${[...VALID_TYPES].join(', ')}`);
  }
  if ((type === 'Pointer' || type === 'Relation') && !targetClass) {
    throw new Error(`Field of type '${type}' must have a targetClass.`);
  }
  if ((min !== undefined || max !== undefined) && type !== 'Number') {
    throw new Error(`min/max options are only valid for Number type, got '${type}'.`);
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`min (${min}) cannot be greater than max (${max}).`);
  }
  if ((minLength !== undefined || maxLength !== undefined) && type !== 'String') {
    throw new Error(`minLength/maxLength options are only valid for String type, got '${type}'.`);
  }
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    throw new Error(`minLength (${minLength}) cannot be greater than maxLength (${maxLength}).`);
  }
  if (minLength !== undefined && minLength < 0) {
    throw new Error(`minLength cannot be negative, got ${minLength}.`);
  }
  if (maxLength !== undefined && maxLength < 0) {
    throw new Error(`maxLength cannot be negative, got ${maxLength}.`);
  }
  if (enumValues !== undefined && type !== 'String') {
    throw new Error(`enum option is only valid for String type, got '${type}'.`);
  }
  if (enumValues !== undefined) {
    if (!Array.isArray(enumValues) || enumValues.length === 0) {
      throw new Error(`enum must be a non-empty array of strings.`);
    }
    if (!enumValues.every(v => typeof v === 'string')) {
      throw new Error(`enum values must all be strings.`);
    }
  }
  if (pattern !== undefined && type !== 'String') {
    throw new Error(`pattern option is only valid for String type, got '${type}'.`);
  }
  if (pattern !== undefined) {
    try { new RegExp(pattern); } catch (e) {
      throw new Error(`pattern is not a valid regular expression: ${pattern}`);
    }
  }
  if (geo !== undefined && type !== 'GeoPoint') {
    throw new Error(`geo option is only valid for GeoPoint type, got '${type}'.`);
  }
  if (geo && (index !== undefined || unique !== undefined)) {
    throw new Error(`geo cannot be combined with index or unique on the same field.`);
  }
  if (ttlSeconds !== undefined) {
    if (type !== 'Date') {
      throw new Error(`ttlSeconds option is only valid for Date type, got '${type}'.`);
    }
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0) {
      throw new Error(`ttlSeconds must be a non-negative integer, got ${ttlSeconds}.`);
    }
    if (index !== undefined || unique !== undefined) {
      throw new Error(`ttlSeconds cannot be combined with index or unique on the same field.`);
    }
  }

  return function (target: Object, propertyKey: string | symbol) {
    // A standard (TC39) decorator is called as (value, context) where context
    // is an object carrying `kind`. Legacy decorators get (target, key). If we
    // are handed the standard shape, `experimentalDecorators` is off and every
    // decorator in the project is quietly doing the wrong thing.
    if (
      propertyKey !== null &&
      typeof propertyKey === 'object' &&
      'kind' in (propertyKey as object)
    ) {
      throw new Error(
        '@ParseField received a standard (TC39) decorator context, which means ' +
          '`experimentalDecorators` is not enabled. This library uses legacy ' +
          'decorators. Set {"compilerOptions": {"experimentalDecorators": true}} ' +
          'in tsconfig.json — without it no model, trigger or cloud function ' +
          'registers correctly.'
      );
    }

    /*
     * Clone-on-first-write, because `getMetadata` walks the prototype chain.
     *
     * On a subclass that has no field metadata of its own yet, `getMetadata`
     * returns the PARENT's object — and writing into it makes every class in
     * the tree share one record. An audit base class is enough to trigger it:
     *
     *   class Auditable extends BaseModel { @ParseField() declare createdBy }
     *   class Product   extends Auditable { @ParseField() declare name }
     *   class Order     extends Auditable { @ParseField() declare total }
     *
     * Shared, Product gains `total`, Order gains `name`, and Auditable gains
     * both — which means wrong schemas, `fromParams` converting fields the
     * model does not have, `validateOrThrow` demanding foreign required
     * fields, and `applyAllIndexes` indexing columns that do not exist. None
     * of it reported.
     *
     * `getOwnMetadata` asks only this class. Absent, copy what was inherited
     * so the subclass keeps its parent's fields, then write into the copy.
     */
    const own = Reflect.getOwnMetadata('parse:fields', target.constructor);
    const existingFields: Record<string, any> =
      own ?? {...(Reflect.getMetadata('parse:fields', target.constructor) || {})};

    const fieldMeta: Record<string, any> = {
      type, required,
      ...(targetClass && {targetClass}),
      ...(description && {description}),
      ...(index && {index}),
      ...(indexName && {indexName}),
      ...(unique && {unique}),
      ...(min !== undefined && {min}),
      ...(max !== undefined && {max}),
      ...(minLength !== undefined && {minLength}),
      ...(maxLength !== undefined && {maxLength}),
      ...(enumValues !== undefined && {enum: enumValues}),
      ...(pattern !== undefined && {pattern}),
      ...(geo && {geo: true}),
      ...(ttlSeconds !== undefined && {ttlSeconds}),
      // Stored only when false: absent means writable, which is the default.
      ...(clientWritable === false && {clientWritable: false}),
    };

    existingFields[propertyKey as string] = fieldMeta;
    Reflect.defineMetadata('parse:fields', existingFields, target.constructor);

    // Define getter and setter for Parse.Object
    Object.defineProperty(target, propertyKey, {
      get(this: Parse.Object) { return this.get(propertyKey as string); },
      set(this: Parse.Object, value: any) { this.set(propertyKey as string, value); },
      enumerable: true,
      configurable: true,
    });

    // Notify hooks
    for (const hook of fieldHooks) {
      hook(target.constructor, propertyKey as string, fieldMeta);
    }
  };
}

// ── Field shadowing repair ──

/**
 * Undo a class field that is hiding one of our accessors.
 *
 * `@ParseField` installs a getter/setter on the **prototype**, which read and
 * write Parse's attribute store. A field written `title!: string` compiles, at
 * `target: ES2022` and above, to an own property set to `undefined` — and an
 * own property shadows a prototype accessor. Reads then return `undefined`,
 * and writes land on the instance instead of Parse, so `save()` sends nothing.
 * Nothing throws at any point.
 *
 * Deleting the own property makes the accessor reachable again. A value is
 * re-assigned through it afterwards, so anything already set still lands where
 * Parse can see it.
 *
 * **This is a no-op for code that does not have the problem.** Below
 * `target: ES2022` — or with `declare` fields, or `useDefineForClassFields`
 * false — no such own property is ever created, so there is nothing to find
 * and nothing changes.
 */
function repairShadowedFields(instance: object, fieldNames: string[]): void {
  for (const name of fieldNames) {
    const own = Object.getOwnPropertyDescriptor(instance, name);

    // An accessor here is already ours. A non-configurable property cannot be
    // removed, and guessing would be worse than leaving it.
    if (!own || own.get || own.set || !own.configurable) continue;

    const value = own.value;
    delete (instance as Record<string, unknown>)[name];
    // Route any value the field carried through the accessor, so it reaches
    // Parse rather than sitting on the instance.
    if (value !== undefined) (instance as Record<string, unknown>)[name] = value;
  }
}

// ── @ParseClass Decorator ──

export interface ParseClassOptions {
  clp?: classLevelPermissions;
  protectedFields?: { [role: string]: string[] };
  ACL?: ClassAclTemplate;
  description?: string;
  compoundIndexes?: CompoundIndex[];
}

export function ParseClass(
  className: ClassNameType,
  options: ParseClassOptions = {}
) {
  return function <T extends Function>(constructor: T): T {
    Reflect.defineMetadata('parse:className', className, constructor);
    Reflect.defineMetadata('parse:clp', options.clp, constructor);
    Reflect.defineMetadata('parse:protectedFields', options.protectedFields, constructor);

    if (options.ACL) {
      Reflect.defineMetadata('parse:defaultACL', options.ACL, constructor);
    }
    if (options.compoundIndexes) {
      Reflect.defineMetadata('parse:compoundIndexes', options.compoundIndexes, constructor);
    }

    const isRoleSubclass = constructor.prototype instanceof Parse.Role;

    const fields = Reflect.getMetadata('parse:fields', constructor) || {};
    const fieldNames = Object.keys(fields);

    /**
     * The class that actually gets constructed.
     *
     * A thin subclass whose constructor undoes any class field shadowing one of
     * our accessors — see `repairShadowedFields`. Everything observable is
     * preserved: `name` is copied over (`@Route` reads it), metadata is
     * inherited through the prototype chain, and `instanceof` still holds
     * because this extends the original.
     *
     * Whether repair is needed is decided once, from the first instance, and
     * then remembered. A codebase without the problem pays one boolean check
     * per object and nothing else.
     */
    let needsRepair: boolean | undefined = undefined;

    const Constructed =
      fieldNames.length === 0
        ? constructor
        : (() => {
            const Wrapped = class extends (constructor as unknown as {
              new (...args: unknown[]): object;
            }) {
              constructor(...args: unknown[]) {
                super(...args);
                if (needsRepair === undefined) {
                  needsRepair = fieldNames.some(name => {
                    const own = Object.getOwnPropertyDescriptor(this, name);
                    return Boolean(own && !own.get && !own.set);
                  });
                }
                if (needsRepair) repairShadowedFields(this, fieldNames);
              }
            };
            // `@Route(Model)` derives its prefix from the class name, so this
            // has to survive the wrapping.
            Object.defineProperty(Wrapped, 'name', {
              value: (constructor as unknown as {name: string}).name,
              configurable: true,
            });
            return Wrapped as unknown as T;
          })();

    if (!isRoleSubclass) {
      // A second registration of the same name means the same file was loaded
      // twice — almost always `importFiles` pointed at a tree holding both the
      // compiled and the source copy. Parse accepts it quietly and the last
      // one wins, which makes the resulting behaviour depend on directory
      // order.
      if (classNames.includes(className)) {
        console.warn(
          `[ParseClass] '${className}' is being registered a second time. ` +
            'The later registration replaces the first. This usually means ' +
            'importFiles ran over a directory containing both compiled and ' +
            'source copies of the same model.'
        );
      } else {
        classNames.push(className);
      }
      Parse.Object.registerSubclass(className, Constructed as unknown as typeof Parse.Object);
    }

    // ── Swagger Registration (built-in) ──
    const properties: Record<string, SwaggerPropertySchema> = {
      objectId: {type: 'string', description: 'Unique object identifier'},
      createdAt: {type: 'string', format: 'date-time', description: 'Creation timestamp'},
      updatedAt: {type: 'string', format: 'date-time', description: 'Last update timestamp'},
    };
    const required: string[] = [];

    for (const [fieldName, fieldMeta] of Object.entries(fields)) {
      const meta = fieldMeta as { type: string; required?: boolean; targetClass?: string; description?: string };
      const swaggerProp = SwaggerRegistry.parseTypeToSwagger(meta.type, meta.targetClass);
      if (meta.description) swaggerProp.description = meta.description;
      properties[fieldName] = swaggerProp;
      if (meta.required) required.push(fieldName);
    }

    SwaggerRegistry.registerModel({
      className,
      description: options.description,
      properties,
      required,
    } as SwaggerModelSchema);

    // ── Trigger Registration (built-in) ──
    const pendingTriggers = Reflect.getMetadata('parse:pendingTriggers', constructor) || [];
    for (const trigger of pendingTriggers) {
      TriggerRegistry.register({
        type: trigger.type,
        className,
        handler: trigger.handler,
        description: trigger.description,
        validation: trigger.validation,
      });
    }
    // This class's triggers are now real; it is no longer waiting.
    markTriggersFlushed(constructor);

    // Notify additional hooks (for custom integrations)
    for (const hook of classHooks) {
      hook(className, constructor, fields, options);
    }

    console.log(`Registered Parse class: ${className}`);

    // Returned so `new Model()` in application code is constructed through the
    // repair too, not only objects Parse builds from the database.
    return Constructed;
  };
}

// ── Schema Utility ──

export function getSchemaDefinition<T>(target: new () => T) {
  const name = Reflect.getMetadata('parse:className', target);
  const fields = Reflect.getMetadata('parse:fields', target) || {};
  const customCLP = (Reflect.getMetadata('parse:clp', target) as classLevelPermissions) || {};
  const protectedFields = (Reflect.getMetadata('parse:protectedFields', target) as ProtectedFields) || {};
  const defaultACL = (Reflect.getMetadata('parse:defaultACL', target) as ClassAclTemplate) || undefined;
  const compoundIndexes = (Reflect.getMetadata('parse:compoundIndexes', target) as CompoundIndex[]) || [];

  let classLevelPermissions: classLevelPermissions | undefined;

  if (Object.keys(customCLP).length > 0) {
    classLevelPermissions = {...customCLP};
    if (Object.keys(protectedFields).length > 0) {
      classLevelPermissions.protectedFields = protectedFields;
    }
    classLevelPermissions.ACL = defaultACL || {'*': {read: true, write: true}};
  }

  const indexes: Record<string, Record<string, 1 | -1>> = {};
  const uniqueFields: string[] = [];

  for (const [fieldName, fieldMeta] of Object.entries(fields)) {
    const meta = fieldMeta as { index?: boolean | 1 | -1; indexName?: string; unique?: boolean };
    if (meta.index) {
      const indexName = meta.indexName || `${fieldName}_index`;
      const indexOrder = meta.index === -1 ? -1 : 1;
      indexes[indexName] = {[fieldName]: indexOrder};
    }
    if (meta.unique) {
      uniqueFields.push(fieldName);
    }
  }

  return {
    className: name,
    fields,
    ...(classLevelPermissions && {classLevelPermissions}),
    ...(Object.keys(indexes).length > 0 && {indexes}),
    ...(uniqueFields.length > 0 && {uniqueFields}),
    ...(compoundIndexes.length > 0 && {compoundIndexes}),
  };
}
