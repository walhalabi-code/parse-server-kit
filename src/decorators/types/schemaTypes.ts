// ClassNames are auto-populated by @ParseClass decorator at runtime
export const classNames: string[] = [];

// ClassNameType is inferred from the classNames array
export type ClassNameType = string;

export type CLPParamsOption =
  | {} // Master key only
  | '*' // Everyone
  | {requiresAuthentication: boolean} // Authenticated users only
  | {[key: string]: boolean}; // Specific role access with boolean value

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
  | {type: 'Pointer'; targetClass: ClassNameType; required: boolean}
  | {type: 'Relation'; targetClass: ClassNameType; required: boolean};

export interface Fields {
  [key: string]: AllowedFieldType;
}

export interface Indexes {
  [indexName: string]: {[fieldName: string]: number};
}

/** Per-field index direction or special MongoDB index type. */
export type IndexFieldType = 1 | -1 | 'text' | '2dsphere' | 'hashed';

/**
 * Compound index definition for creating indexes on multiple fields
 */
export interface CompoundIndex {
  /** Array of field names to include in the compound index */
  fields: string[];
  /** Whether this compound index should enforce uniqueness */
  unique?: boolean;
  /** Optional custom index name (defaults to fields joined by underscore + _unique/_index) */
  name?: string;
  /** If true, index only documents that contain the indexed fields (skips null values) */
  sparse?: boolean;
  /**
   * If true, only index documents where ALL indexed fields exist and are not null.
   * This is more reliable than sparse for compound unique indexes.
   */
  partialFilterNulls?: boolean;
  /**
   * Per-field index type. Default 1 (ascending B-tree) for any field not listed.
   * Use 'text' for full-text search, '2dsphere' for geo, 'hashed' for hashed
   * sharding keys, -1 for descending B-tree.
   */
  fieldTypes?: Record<string, IndexFieldType>;
  /**
   * Extra MongoDB index options that don't fit the dedicated flags
   * (e.g., default_language for text indexes). Merged into createIndex options.
   */
  options?: Record<string, unknown>;
}

export interface ProtectedFields {
  '*': string[];
  authenticated: string[];
  [key: string]: string[];
}

// Permissions allowed for each ACL entry
export type AclTemplatePermissions = {
  read?: boolean;
  write?: boolean;
};

// The ACL template: key = "*", "currentUser", "role:RoleName", or specific userId
export type ClassAclTemplate = {
  [key: string]: AclTemplatePermissions;
};

export interface classLevelPermissions {
  find?: CLPParamsOption;
  get?: CLPParamsOption;
  count?: CLPParamsOption;
  create?: CLPParamsOption;
  update?: CLPParamsOption;
  delete?: CLPParamsOption;
  protectedFields?: ProtectedFields;
  ACL?: ClassAclTemplate;
}

export interface SchemaDefinition {
  className: ClassNameType;
  fields: Fields;
  indexes?: Indexes;
  classLevelPermissions?: classLevelPermissions;
}
