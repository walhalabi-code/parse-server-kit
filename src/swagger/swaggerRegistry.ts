import 'reflect-metadata';
import type {RouteConfig} from '../decorators/types/cloudTypes';

export interface SwaggerModelSchema {
  className: string;
  description?: string;
  properties: Record<string, SwaggerPropertySchema>;
  required: string[];
}

export interface SwaggerPropertySchema {
  type: string;
  format?: string;
  description?: string;
  $ref?: string;
  items?: { type?: string; $ref?: string };
  nullable?: boolean;
  /** Per-field required flag — read by swaggerSpec to build the required[] array. */
  required?: boolean;
}

export interface SwaggerFunctionSchema {
  name: string;
  method: string;
  /** The real REST route (from @Route), e.g. '/ai-provider-configs/getX'. */
  path?: string;
  description?: string;
  summary?: string;
  tags?: string[];
  requiresAuth: boolean;
  requestBody?: {
    required: boolean;
    properties: Record<string, SwaggerPropertySchema>;
  };
  responses?: Record<string, { description: string; schema?: any }>;
}

/**
 * Registry for collecting Swagger/OpenAPI documentation metadata
 */
export class SwaggerRegistry {
  private static models: Map<string, SwaggerModelSchema> = new Map();
  private static functions: Map<string, SwaggerFunctionSchema> = new Map();

  /**
   * Bumped on every change to what the spec would contain.
   *
   * Lets `setupSwagger` cache the generated document and still be correct: it
   * compares revisions rather than trusting that registration stopped at boot.
   * Anything registered later invalidates the cache on its own, with no call to
   * remember.
   */
  private static revision = 0;

  /** The current content revision. Changes whenever the spec would change. */
  static getRevision(): number {
    return this.revision;
  }

  /**
   * Register a model for Swagger documentation
   */
  static registerModel(schema: SwaggerModelSchema) {
    this.models.set(schema.className, schema);
    this.revision += 1;
    console.log(`[Swagger] Registered model: ${schema.className}`);
  }

  /**
   * Register a cloud function for Swagger documentation
   */
  static registerFunction(schema: SwaggerFunctionSchema) {
    this.functions.set(schema.name, schema);
    this.revision += 1;
    console.log(`[Swagger] Registered function: ${schema.name}`);
  }

  /**
   * Attach the real REST route to an already-registered function. Called from
   * RouteRegistry.initialize() once @Route prefixes are resolved, so the spec
   * documents the actual entity routes instead of the legacy /functions/ path.
   */
  static setFunctionPath(name: string, path: string) {
    const fn = this.functions.get(name);
    if (fn) {
      fn.path = path;
      this.revision += 1;
    }
  }

  /**
   * Build + register a cloud function's Swagger schema straight from its
   * @CloudFunction RouteConfig. Mirrors how models are registered from their
   * @ParseField decorators, so endpoints appear in the spec automatically.
   */
  static registerFunctionFromRoute(name: string, config: RouteConfig) {
    const v = (config.validation ?? {}) as {
      requireUser?: boolean;
      requireMaster?: boolean;
      requireAnyUserRoles?: unknown;
      fields?: string[] | Record<string, {type?: unknown; required?: boolean}>;
    };

    const requiresAuth = Boolean(
      config.requiresAuth ||
        v.requireUser ||
        v.requireMaster ||
        (Array.isArray(v.requireAnyUserRoles) && v.requireAnyUserRoles.length) ||
        (Array.isArray(config.requireRoles) && config.requireRoles.length),
    );

    // Map the validation fields → request body properties.
    const properties: Record<string, SwaggerPropertySchema> = {};
    const fields = v.fields;
    if (Array.isArray(fields)) {
      for (const fname of fields) {
        properties[fname] = {type: 'string', required: true};
      }
    } else if (fields && typeof fields === 'object') {
      for (const [fname, def] of Object.entries(fields)) {
        const prop = this.validationTypeToSwagger(def?.type);
        if (def?.required) prop.required = true;
        properties[fname] = prop;
      }
    }
    const requestBody =
      Object.keys(properties).length > 0
        ? {required: true, properties}
        : undefined;

    this.registerFunction({
      name,
      method: config.methods?.[0] ?? 'POST',
      summary: config.swagger?.summary,
      description: config.swagger?.description ?? config.description,
      tags: config.swagger?.tags,
      requiresAuth,
      requestBody,
      responses: config.swagger?.responses ?? {
        '200': {description: 'Success'},
      },
    });
  }

  /**
   * Get all registered models
   */
  static getModels() {
    return Array.from(this.models.values());
  }

  /**
   * Get all registered functions
   */
  static getFunctions() {
    return Array.from(this.functions.values());
  }

  /**
   * Get a specific model by name
   */
  static getModel(name: string) {
    return this.models.get(name);
  }

  /**
   * Get a specific function by name
   */
  static getFunction(name: string) {
    return this.functions.get(name);
  }

  /**
   * Normalize class name to match Parse Server conventions
   * (e.g., 'User' -> '_User', 'Role' -> '_Role')
   */
  static normalizeClassName(className?: string): string | undefined {
    if (!className) return undefined;

    // Parse built-in classes use underscore prefix
    const builtInClasses = ['User', 'Role', 'Session', 'Installation'];
    if (builtInClasses.includes(className)) {
      return `_${className}`;
    }
    return className;
  }

  /**
   * Convert Parse field type to Swagger/OpenAPI type
   */
  static parseTypeToSwagger(
    fieldType: string,
    targetClass?: string
  ): SwaggerPropertySchema {
    const normalizedClass = this.normalizeClassName(targetClass);
    const typeMap: Record<string, SwaggerPropertySchema> = {
      String: { type: 'string' },
      Number: { type: 'number' },
      Boolean: { type: 'boolean' },
      Date: { type: 'string', format: 'date-time' },
      Object: { type: 'object' },
      Array: { type: 'array', items: { type: 'string' } },
      GeoPoint: {
        type: 'object',
        description: 'GeoPoint with latitude and longitude',
      },
      File: { type: 'object', description: 'Parse File object' },
      Bytes: { type: 'string', format: 'byte' },
      Polygon: { type: 'object', description: 'Polygon coordinates' },
      Pointer: {
        type: 'object',
        description: `Pointer to ${targetClass || 'unknown'}`,
        $ref: normalizedClass ? `#/components/schemas/${normalizedClass}` : undefined,
      },
      Relation: {
        type: 'array',
        description: `Relation to ${targetClass || 'unknown'}`,
        items: {
          $ref: normalizedClass ? `#/components/schemas/${normalizedClass}` : undefined,
        },
      },
    };

    return typeMap[fieldType] || { type: 'string' };
  }

  /**
   * Convert validation field type to Swagger type
   */
  static validationTypeToSwagger(type: any): SwaggerPropertySchema {
    if (type === String) return { type: 'string' };
    if (type === Number) return { type: 'number' };
    if (type === Boolean) return { type: 'boolean' };
    if (type === Array) return { type: 'array', items: { type: 'string' } };
    if (type === Object) return { type: 'object' };
    return { type: 'string' };
  }
}
