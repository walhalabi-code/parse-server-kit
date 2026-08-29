/**
 * Settings this library needs but should not assume.
 *
 * These used to be constants, read straight from the environment or hardcoded
 * to one project's conventions — a mount path from `process.env.mountPath`, an
 * admin role called `SuperAdmin`, a pointer class called `IMG`. That works
 * perfectly for the codebase they came from and confuses everyone else, who has
 * different role names, different models, and no reason to know that this
 * particular environment variable is load-bearing.
 *
 * Every default below reproduces the previous behaviour exactly, so an existing
 * project that calls nothing here is unaffected.
 *
 * ```ts
 * configureKit({mountPath: '/api', adminRole: 'Owner'});
 * ```
 *
 * Values are resolved when they are *used*, not when this module loads, so
 * `dotenv` (or anything else that populates the environment after import) still
 * works.
 */
export interface KitConfig {
  /**
   * Where Parse Server is mounted, e.g. `/parse`.
   *
   * Used to recognise file routes and as the default Swagger server URL.
   * Falls back to `process.env.mountPath` — the variable this library used to
   * read directly — and then to `/parse`, Parse Server's own default.
   */
  mountPath?: string;

  /**
   * The master key, used by `restrictRoutes` to let privileged callers past
   * the route restrictions.
   *
   * Falls back to `process.env.masterKey` — the variable this library used to
   * read directly. **If neither is set, the master key bypass never fires**,
   * and a caller presenting a perfectly valid master key is still refused.
   * That failure is silent, which is why it is worth setting explicitly.
   */
  masterKey?: string;

  /**
   * The role allowed to manage the `_Role` class in a generated schema.
   * Default `SuperAdmin`.
   */
  adminRole?: string;

  /**
   * Let Parse Server's own auth endpoints through `restrictRoutes`.
   * Default `false`.
   *
   * `restrictRoutes` closes the generic REST API so that clients go through the
   * cloud functions you declared rather than querying whatever they like. Parse's
   * auth endpoints — `/login`, `/logout`, `POST /users` (signup),
   * `/requestPasswordReset`, `/verificationEmailRequest` — are closed along with
   * the rest of it, and the documented approach is to expose the ones you want
   * as cloud functions:
   *
   * ```ts
   * @Route(User)
   * class UserFunctions {
   *   @CloudFunction({methods: ['POST']})
   *   static async logIn(req) { ... }     // POST /api/users/logIn
   * }
   * ```
   *
   * That is the right default for a REST client you control. It is the **wrong**
   * default if your client is one of Parse's official SDKs: `Parse.User.logIn()`
   * in the browser, on iOS or on Android calls `/login` directly, and there is no
   * way to point it at a cloud function instead. Those apps need this set to
   * `true` or they cannot authenticate at all.
   *
   * Turning it on allows exactly the auth endpoints, and only with the method
   * that makes sense: `POST /users` signs a user up, while `GET /users` — which
   * would query the whole user table — stays blocked.
   */
  allowAuthRoutes?: boolean;

  /**
   * Pointer target classes that `BaseModel.fromParams()` skips.
   *
   * These are classes whose pointers need handling of their own — an uploaded
   * image that has to be processed before it can be attached, for instance —
   * so blindly building a pointer from request params would be wrong.
   * Default `['IMG', 'File']`.
   *
   * A single model can still override this with a static of the same name.
   */
  excludedPointerClasses?: string[];
}

const DEFAULTS = {
  adminRole: 'SuperAdmin',
  excludedPointerClasses: ['IMG', 'File'],
  mountPath: '/parse',
  // Off, so an existing deployment's exposed surface does not widen because it
  // upgraded. Opening a route is a decision the application should make.
  allowAuthRoutes: false,
} as const;

let overrides: KitConfig = {};

/**
 * Set any of the library's settings. Merges with whatever was set before, so it
 * can be called more than once, and can be called at any point before the
 * values are used.
 */
export function configureKit(config: KitConfig): void {
  overrides = {...overrides, ...config};
}

/** Everything resolved, in precedence order: explicit → environment → default. */
export function kitConfig(): Required<KitConfig> {
  return {
    mountPath:
      overrides.mountPath ?? process.env.mountPath ?? DEFAULTS.mountPath,
    // No default: an absent master key must never match, so a misconfigured
    // server fails closed rather than admitting everyone as master.
    masterKey: overrides.masterKey ?? process.env.masterKey ?? '',
    adminRole: overrides.adminRole ?? DEFAULTS.adminRole,
    allowAuthRoutes: overrides.allowAuthRoutes ?? DEFAULTS.allowAuthRoutes,
    excludedPointerClasses:
      overrides.excludedPointerClasses ?? [...DEFAULTS.excludedPointerClasses],
  };
}

/** Drop every override and go back to the defaults. Intended for tests. */
export function resetKitConfig(): void {
  overrides = {};
}
