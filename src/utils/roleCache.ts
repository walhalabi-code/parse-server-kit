/**
 * Role membership, remembered for a while.
 *
 * `@CloudFunction({requireRoles})` asks the database who a user is on every
 * single call, and so does every `getUserRoles()`. That is a full round-trip —
 * milliseconds, not microseconds — to answer a question whose answer almost
 * never changes.
 *
 * **Off by default, and deliberately so.** Caching membership means a revoked
 * role keeps working until the entry expires. That is a security trade, and it
 * belongs to whoever runs the deployment, not to this library. Nothing here
 * takes effect until `configureRoleCache()` is called.
 *
 * When it is on, `invalidateRoles(userId)` is the tool that keeps the window
 * from mattering: call it wherever you grant or revoke, and the TTL becomes a
 * backstop for changes made outside your code rather than the primary control.
 *
 * There is no timer. Entries expire when read and the map is capped on write,
 * so importing this module costs nothing and holds nothing open.
 */

interface CacheEntry {
  roles: string[];
  expiresAt: number;
}

export interface RoleCacheOptions {
  /** How long a user's role list may be reused, in milliseconds. */
  ttlMs: number;
  /**
   * Most users to remember at once. Oldest entries are dropped past this.
   * Default 10000 — a bound against memory growth, not a tuning knob.
   */
  maxUsers?: number;
}

const DEFAULT_MAX_USERS = 10_000;

let options: Required<RoleCacheOptions> | null = null;
const cache = new Map<string, CacheEntry>();

/**
 * Turn the cache on, change its settings, or turn it off with `false`.
 *
 * Switching off clears whatever was held, so a deployment can disable it and be
 * certain nothing stale survives.
 */
export function configureRoleCache(config: RoleCacheOptions | false): void {
  if (config === false) {
    options = null;
    cache.clear();
    return;
  }

  if (!Number.isFinite(config.ttlMs) || config.ttlMs <= 0) {
    throw new Error(
      `configureRoleCache: ttlMs must be a positive number, got ${config.ttlMs}. ` +
        'Pass `false` to disable the cache.'
    );
  }

  options = {
    ttlMs: config.ttlMs,
    maxUsers: config.maxUsers ?? DEFAULT_MAX_USERS,
  };
}

export function roleCacheEnabled(): boolean {
  return options !== null;
}

/**
 * Forget a user's roles, or everyone's.
 *
 * Call this wherever a role is granted or revoked. Safe to call when the cache
 * is off — it simply has nothing to do.
 */
export function invalidateRoles(userId?: string): void {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}

/** For tests and for reporting. */
export function roleCacheStats(): {enabled: boolean; size: number; ttlMs: number | null} {
  return {
    enabled: options !== null,
    size: cache.size,
    ttlMs: options?.ttlMs ?? null,
  };
}

/**
 * The cached roles for this user, or nothing if there is no live entry.
 *
 * `ttlOverrideMs` of 0 means "do not use the cache for this call" — how a
 * single cloud function opts out of a global policy.
 */
export function readCachedRoles(
  userId: string,
  ttlOverrideMs?: number
): string[] | undefined {
  if (!options || ttlOverrideMs === 0) return undefined;

  const entry = cache.get(userId);
  if (!entry) return undefined;

  if (Date.now() >= entry.expiresAt) {
    cache.delete(userId);
    return undefined;
  }

  // A copy, not the stored array. Handing out the internal one means a caller
  // that sorts or filters it in place silently rewrites what every later
  // permission check for this user sees.
  return entry.roles.slice();
}

/** Remember this user's roles. A no-op while the cache is off. */
export function writeCachedRoles(
  userId: string,
  roles: string[],
  ttlOverrideMs?: number
): void {
  if (!options || ttlOverrideMs === 0) return;

  // Map preserves insertion order, so the first key is the oldest write.
  if (cache.size >= options.maxUsers && !cache.has(userId)) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }

  cache.set(userId, {
    roles,
    expiresAt: Date.now() + (ttlOverrideMs ?? options.ttlMs),
  });
}
