// parse-server-kit — complete toolkit for Parse Server

// MUST stay first. Models subclass `Parse.Object` while their module is being
// evaluated, so the global has to exist before any export below is loaded.
// See the file for why this is not simply `import 'parse/node'`.
import './ensureParse';

// ── Configuration ──
export { configureKit, kitConfig, resetKitConfig } from './config';
export type { KitConfig } from './config';

// ── Decorators ──
export { ParseClass, ParseField, getSchemaDefinition, onClassRegistered, onFieldRegistered } from './decorators/parseDecorators';
export type { ParseClassOptions, ParseFieldOptions, AllowedFieldType } from './decorators/parseDecorators';

export { CloudFunction, ProtectedCloudFunction, onFunctionRegistered } from './decorators/cloudDecorator';
export { CloudFunctionRegistry } from './decorators/cloudRegistry';

export { BeforeSave, AfterSave, BeforeDelete, AfterDelete, BeforeFind, AfterFind,
  BeforeLogin, AfterLogin, AfterLogout, BeforePasswordResetRequest,
  BeforeSaveFile, AfterSaveFile, BeforeDeleteFile, AfterDeleteFile,
  BeforeFindFile, AfterFindFile,
  BeforeSaveConfig, AfterSaveConfig,
  BeforeConnect, BeforeSubscribe, AfterEvent } from './decorators/triggerDecorator';
export { TriggerRegistry } from './decorators/triggerRegistry';

export { Cron, CronSchedule, CronRegistry } from './decorators/cronDecorator';

export { Route, RouteRegistry } from './decorators/routeDecorator';

// ── Types ──
export { classNames } from './decorators/types/schemaTypes';
export type { ClassNameType, CLPParamsOption, classLevelPermissions, ClassAclTemplate,
  AclTemplatePermissions, ProtectedFields, CompoundIndex, IndexFieldType, Fields, Indexes, SchemaDefinition } from './decorators/types/schemaTypes';

export type { HttpMethod, RouteConfig, CloudFunctionMetadata, SwaggerDocConfig } from './decorators/types/cloudTypes';
export type { TriggerType, TriggerMetadata, TriggerConfig } from './decorators/types/triggerTypes';
export type { CronJobMetadata, CronConfig } from './decorators/types/cronTypes';
export type { AuthRole, MultiLangs, Filter } from './decorators/types/common';

// ── Validation ──
export { validateObject, validateOrThrow, getValidators, applyMongoValidators } from './decorators/types/fieldValidation';

// ── Models ──
export { BaseModel } from './models/BaseModel';

// ── ACL & Permissions ──
export { implementACL } from './utils/ACL';
export { syncImageAcl, cloneAcl } from './utils/imageAcl';
export { UserRoles, roleKey, MAX_QUERY_LIMIT } from './utils/constants';
export type { RoleString } from './utils/constants';

// ── Utilities ──
export { catchError, getUserRoles, getUsersRoles, formatCount,
  generateRandomPassword, generateRandomInteger, generateRandomString, sleep } from './utils/helper';
export { importFiles } from './utils/dynamicImport';
export { paginate } from './utils/pagination';
export type { Page, PaginateOptions } from './utils/pagination';

// ── Role cache (opt-in) ──
export { configureRoleCache, invalidateRoles, roleCacheEnabled, roleCacheStats } from './utils/roleCache';
export type { RoleCacheOptions } from './utils/roleCache';

// ── Middleware ──
export { validateFunctionRoutes, validateEntityRoutes, restrictRoutes,
  removeResultMiddleware, conditionalJsonMiddleware } from './middleware/middleware';
export { checkRateLimit } from './middleware/rateLimit';

// ── Database ──
export { createSchemaConfig } from './database/schema';
export type { SchemaConfigOptions } from './database/schema';
export { applyAllIndexes, applyUniqueIndexes, getUniqueIndexes, getCompoundIndexes, getFieldIndexes } from './database/indexes';

// ── Optimistic Locking ──
export { ParseVersionField, VersionRegistry } from './database/versionRegistry';
export { createVersionedMongoAdapter, VERSION_CONFLICT, VERSION_CONFLICT_MESSAGE } from './database/versionedMongoAdapter';
export type { VersionedMongoAdapter, MongoAdapterConstructor } from './database/versionedMongoAdapter';

// ── Transactions ──
export { Transactional, withTransaction, inTransaction, currentSession,
  useTransactionAdapter, CONFLICT, CONFLICT_MESSAGE } from './transactions/context';
export type { TransactionalAdapter } from './transactions/context';
export { withAmbientSession, NO_AMBIENT_TRANSACTION } from './transactions/ambientSession';

// ── Swagger ──
export { SwaggerRegistry } from './swagger/swaggerRegistry';
export type { SwaggerModelSchema, SwaggerPropertySchema, SwaggerFunctionSchema } from './swagger/swaggerRegistry';
export { generateSwaggerSpec, getSwaggerJson } from './swagger/swaggerSpec';
export { setupSwagger } from './swagger/index';
