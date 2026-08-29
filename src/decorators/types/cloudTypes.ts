export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface SwaggerDocConfig {
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  responses?: Record<string, { description: string; schema?: any }>;
}

export interface RouteConfig {
  methods: HttpMethod[];

  /**
   * Refuse the call unless somebody is signed in.
   *
   * Enforced in the handler wrapper before your body runs: no user and no
   * master key gives `OBJECT_NOT_FOUND 'Authentication required'`. It also
   * drives the security scheme in the OpenAPI output.
   *
   * `validation: {requireUser: true}` does the same job through Parse Server's
   * own validator and is equally valid — that one also runs before the
   * function is entered. Use either; using both is harmless.
   */
  requiresAuth?: boolean;

  /**
   * Token bucket, per process. Enforced whether the caller comes through the
   * entity route or straight at `/functions/{name}`.
   *
   * **Per process** — with several instances behind a load balancer each keeps
   * its own count, so the effective limit is `max` times the instance count.
   */
  rateLimit?: { windowMs: number; max: number };
  validation?: Parse.Cloud.Validator;
  description?: string;
  requireRoles?: string[];
  requireAllRoles?: boolean;
  /**
   * Overrides the global role cache for this function only.
   *
   * `0` opts out entirely — the role check always hits the database, whatever
   * `configureRoleCache` says. Use it on the few endpoints where acting on a
   * just-revoked role is unacceptable. A positive number sets a shorter or
   * longer TTL than the global one. Omitted, the global policy applies.
   *
   * Has no effect unless `configureRoleCache()` has turned the cache on.
   */
  roleCacheMs?: number;
  customErrorMessage?: string;
  swagger?: SwaggerDocConfig;
}

export interface CloudFunctionMetadata {
  name: string;
  config: RouteConfig;
  /**
   * The method as it stood when `@CloudFunction` was applied.
   *
   * Kept as a fallback. The registry prefers to re-read the method from its
   * owner at `initialize()` time, so that decorators applied *above*
   * `@CloudFunction` are still in place — see `owner`.
   */
  handler: (request: Parse.Cloud.FunctionRequest) => Promise<any> | any;
  /** The class the method lives on, so the registry can re-read it later. */
  owner?: any;
  /** The property name on `owner`. */
  propertyKey?: string;
  routePrefix?: string;
}
