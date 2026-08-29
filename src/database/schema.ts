import {getSchemaDefinition} from '../decorators/parseDecorators';
import {classNames} from '../decorators/types/schemaTypes';
import {kitConfig} from '../config';

export interface SchemaConfigOptions {
  /**
   * Role name that can manage the `_Role` class.
   *
   * Defaults to the library-wide `adminRole` — `'SuperAdmin'` unless you have
   * called `configureKit({adminRole})`.
   */
  adminRole?: string;
  /** Lock schema in production — reject new classes/fields. Default: false */
  lockSchemas?: boolean;
  /** Enforce schema on start — create missing classes/fields. Default: true */
  strict?: boolean;
  /** Drop and recreate fields with wrong type. DANGEROUS. Default: false */
  recreateModifiedFields?: boolean;
  /** Delete fields not in schema. DANGEROUS. Default: false */
  deleteExtraFields?: boolean;
  /**
   * Keep indexes that this schema does not describe. Default: `true`.
   *
   * `applyAllIndexes()` creates unique, compound, TTL and 2dsphere indexes by
   * talking to the MongoDB driver directly, which means parse-server's schema
   * sync has never heard of them. Left to itself it treats an index it cannot
   * account for as drift and drops it — taking your uniqueness constraints with
   * it, quietly, on a restart.
   *
   * Defaulted to `true` because the alternative loses data integrity by
   * accident. Requires parse-server 8.3+; older servers ignore it.
   */
  keepUnknownIndexes?: boolean;
}

/**
 * Creates Parse Server schema configuration from decorator metadata.
 * Reads all @ParseClass and @ParseField decorators automatically.
 */
export function createSchemaConfig(options: SchemaConfigOptions = {}) {
  const {
    adminRole = kitConfig().adminRole,
    lockSchemas = false,
    strict = true,
    recreateModifiedFields = false,
    deleteExtraFields = false,
    keepUnknownIndexes = true,
  } = options;

  return {
    definitions: [
      {
        className: '_Role',
        fields: {},
        classLevelPermissions: {
          find: {[`role:${adminRole}`]: true},
          get: {[`role:${adminRole}`]: true},
          count: {[`role:${adminRole}`]: true},
          create: {[`role:${adminRole}`]: true},
          update: {[`role:${adminRole}`]: true},
          delete: {[`role:${adminRole}`]: true},
          protectedFields: {},
        },
      },
      ...classNames.map(className => {
        const classConstructor = Parse.Object.extend(className);
        return getSchemaDefinition(classConstructor);
      }),
    ],
    lockSchemas,
    strict,
    recreateModifiedFields,
    deleteExtraFields,
    keepUnknownIndexes,
  };
}
