import {CloudFunctionMetadata, RouteConfig} from './types/cloudTypes';
import {catchError} from '../utils/helper';
import {readCachedRoles, roleCacheEnabled, writeCachedRoles} from '../utils/roleCache';
import {CloudFunctionRegistry} from './cloudRegistry';
import {SwaggerRegistry} from '../swagger/swaggerRegistry';

// Hook for Swagger integration (optional — set by consumer)
type OnFunctionRegistered = (name: string, config: RouteConfig, target: any) => void;
const functionHooks: OnFunctionRegistered[] = [];
export function onFunctionRegistered(hook: OnFunctionRegistered) {
  functionHooks.push(hook);
}

export function CloudFunction(config: RouteConfig) {
  return function (
    target: any,
    propertyKey: string,
    descriptor?: PropertyDescriptor | undefined
  ) {
    if (!descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
    }
    if (!descriptor) {
      throw new Error(`Descriptor not found for property ${propertyKey}`);
    }

    const originalMethod = descriptor.value;

    // Wrap with the auth and role checks
    descriptor.value = async function (...args: any[]) {
      const request = args[0] as Parse.Cloud.FunctionRequest;

      /*
       * `requiresAuth` used to be read by nothing but the Swagger renderer, so
       * an endpoint declaring it was wide open while the docs drew a padlock on
       * it — the exact silent failure this library exists to remove, and one
       * character away from `validation.requireUser`, which did work.
       *
       * The master key is the system, so it passes: a cloud function called
       * with the master key has no `request.user` and is not an anonymous
       * caller.
       */
      if (config.requiresAuth && !request.user && !request.master) {
        throw new Parse.Error(
          Parse.Error.OBJECT_NOT_FOUND,
          'Authentication required'
        );
      }

      if (config.requireRoles) {
        await checkUserRoles(request, config);
      }

      return originalMethod.apply(this, args);
    };

    const metadata: CloudFunctionMetadata = {
      name: propertyKey,
      config,
      handler: descriptor.value,
      // Recorded so the registry can re-read the method when it registers it,
      // rather than keeping this snapshot. Decorators apply bottom-up, so
      // anything written *above* @CloudFunction has not run yet and is not in
      // `descriptor.value` — @Transactional most notably. Re-reading later
      // picks it up and makes the order of the two irrelevant.
      owner: target,
      propertyKey,
    };
    CloudFunctionRegistry.register(metadata);

    // Register the endpoint for Swagger — mirrors how @ParseField registers
    // models, so the OpenAPI spec gets paths automatically (not just schemas).
    SwaggerRegistry.registerFunctionFromRoute(propertyKey, config);

    // Notify hooks (Swagger, etc.)
    for (const hook of functionHooks) {
      hook(propertyKey, config, target);
    }

    return descriptor;
  };
}

/**
 * The roles this user holds, as far as this check needs to know.
 *
 * Two shapes, because the cache changes what is worth asking for. Uncached, the
 * query is narrowed to the roles this function actually requires — the cheapest
 * question, and exactly what this has always done. Cached, the full list is
 * fetched instead: it answers every function's question, not just this one, so
 * one round-trip serves the whole request and every later one until it expires.
 */
async function resolveRoleNames(
  user: Parse.User,
  config: RouteConfig
): Promise<string[]> {
  const useCache = roleCacheEnabled() && config.roleCacheMs !== 0;

  if (!useCache) {
    const roleQuery = new Parse.Query('_Role');
    roleQuery.containedIn('name', config.requireRoles!);
    roleQuery.equalTo('users', user);
    const [error, roles] = await catchError(roleQuery.find({useMasterKey: true}));
    if (error) {
      throw new Parse.Error(Parse.Error.OTHER_CAUSE, 'Authorization check failed');
    }
    return roles!.map(role => role.get('name'));
  }

  const cached = readCachedRoles(user.id!, config.roleCacheMs);
  if (cached) return cached;

  const roleQuery = new Parse.Query('_Role');
  roleQuery.equalTo('users', user);
  const [error, roles] = await catchError(roleQuery.find({useMasterKey: true}));
  if (error) {
    throw new Parse.Error(Parse.Error.OTHER_CAUSE, 'Authorization check failed');
  }

  const names = roles!.map(role => role.get('name'));
  writeCachedRoles(user.id!, names, config.roleCacheMs);
  return names;
}

async function checkUserRoles(
  request: Parse.Cloud.FunctionRequest,
  config: RouteConfig
): Promise<void> {
  /*
   * The master key is the system, and passes — the same reading `requiresAuth`
   * takes, so the two gates agree about the same caller.
   *
   * It is not a loosening in any real sense. A caller holding the master key is
   * already past `restrictRoutes`, already bypasses every CLP and ACL by
   * Parse's own design, and could add itself to the required role and call
   * again. Refusing it here stopped nobody; it only answered a legitimate
   * server-side caller — a cron job, a migration, an admin script — with
   * `Authentication required`, which is a confusing thing to tell the most
   * privileged principal in the system.
   */
  if (request.master) return;

  const user = request.user;
  if (!user) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Authentication required');
  }
  if (!config.requireRoles || config.requireRoles.length === 0) return;

  const userRoleNames = await resolveRoleNames(user, config);

  const hasPermission = config.requireAllRoles
    ? config.requireRoles.every(role => userRoleNames.includes(role))
    : config.requireRoles.some(role => userRoleNames.includes(role));

  if (!hasPermission) {
    const msg = config.customErrorMessage ||
      `Access denied. Required ${config.requireAllRoles ? 'all' : 'one of'} these roles: ${config.requireRoles.join(', ')}`;
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, msg);
  }
}

export function ProtectedCloudFunction(config: Partial<RouteConfig> = {}) {
  return CloudFunction({
    methods: ['POST'],
    validation: { requireUser: true },
    ...config,
  });
}
