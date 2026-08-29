import {timingSafeEqual} from 'node:crypto';
import express, {NextFunction, Request, Response} from 'express';
import {CloudFunctionRegistry} from '../decorators/cloudRegistry';
import {isUnderPrefix, RouteRegistry} from '../decorators/routeDecorator';
import {HttpMethod} from '../decorators/types/cloudTypes';
import {checkRateLimit} from './rateLimit';
import {kitConfig} from '../config';

/**
 * Validates legacy `/functions/*` routes.
 *
 * **Legacy, and not needed by new projects** — `restrictRoutes` now applies the
 * declared method and rate limit to `/functions/{name}` itself, which is where
 * this was the only cover before.
 *
 * Kept because it is exported and something may mount it. It works whether it
 * is mounted at the app root (so paths arrive as `/functions/myFn`) or under
 * `{mountPath}/functions` (arriving as `/myFn`); it used to read the segment
 * blindly and therefore 404 everything in the first case.
 */
export function validateFunctionRoutes(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Skip if already handled by entity route middleware
  if ((req as any)._entityRouteHandled) {
    return next();
  }

  const segments = req.path.split('/').filter(Boolean);
  // Tolerate a leading "functions" segment, so the same middleware works at
  // either mount point.
  const functionName = segments[0] === 'functions' ? segments[1] : segments[0];
  const metadata = functionName
    ? CloudFunctionRegistry.getFunction(functionName)
    : undefined;

  if (!metadata) {
    return res.status(404).json({message: 'Function not found'});
  }

  if (!metadata.config.methods.includes(req.method as HttpMethod)) {
    return res.status(405).json({message: 'Method not allowed'});
  }

  req.method = 'POST';
  return next();
}

/**
 * Validates entity-based routes: /api/{entity}/{action}
 * Resolves to a cloud function name and rewrites the URL for Parse Server.
 *
 * Flow:
 *   1. Skip CORS preflight (OPTIONS)
 *   2. Skip non-entity routes (pass to next middleware)
 *   3. Resolve route → cloud function name
 *   4. Validate HTTP method
 *   5. Rewrite URL to /functions/{name} with query string preserved
 *   6. Merge GET query params into body (Parse reads from body)
 *   7. Convert to POST for Parse Server
 */
export function validateEntityRoutes(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const routePath = req.path;

  // Skip CORS preflight — let cors() middleware handle them
  if (req.method === 'OPTIONS') {
    return next();
  }

  // Only handle requests that match a registered entity prefix
  if (!RouteRegistry.isRegisteredPrefix(routePath)) {
    return next();
  }

  const functionName = RouteRegistry.resolve(routePath);

  if (!functionName) {
    return res.status(404).json({message: 'Route not found'});
  }

  const metadata = CloudFunctionRegistry.getFunction(functionName);
  if (!metadata) {
    return res.status(404).json({message: 'Function not found'});
  }

  if (!metadata.config.methods.includes(req.method as HttpMethod)) {
    return res.status(405).json({message: 'Method not allowed'});
  }

  // Rate limit check — if config exists and limit exceeded, returns 429
  if (metadata.config.rateLimit) {
    const allowed = checkRateLimit(req, res, functionName, metadata.config.rateLimit);
    if (!allowed) return; // 429 already sent
  }

  // Rewrite URL to /functions/{functionName} so Parse Server handles it
  // Preserve query string for GET requests
  const queryString = req.originalUrl.split('?')[1];
  req.url = `/functions/${functionName}${queryString ? '?' + queryString : ''}`;

  // Merge GET query params into body — Parse Server reads params from body
  if (req.method === 'GET' && req.query && Object.keys(req.query).length > 0) {
    req.body = {...req.body, ...req.query};
  }

  req.method = 'POST';
  (req as any)._entityRouteHandled = true;
  return next();
}

/** The only two body keys that can carry a master key. */
const MASTER_KEY_MARKERS = ['masterKey', '_MasterKey'];

/**
 * Extracts master key from the request body during JSON parsing.
 * Used as the `verify` callback in express.json().
 *
 * **Scans before it parses.** body-parser hands this the raw buffer and then
 * parses that same buffer itself — so a `JSON.parse` here is a second, complete
 * parse of every request body in the system, and it exists only to look for one
 * key that is absent from virtually every request.
 *
 * `Buffer.includes` searches bytes: no string allocation, no parse, no object.
 * If neither marker is present there is nothing to extract, and the body is
 * left entirely to body-parser. Only a body that actually mentions a master key
 * pays for parsing.
 */
export function extractMasterKey(
  req: any,
  res: Response,
  buf: Buffer,
  encoding: BufferEncoding
) {
  if (!MASTER_KEY_MARKERS.some(marker => buf.includes(marker))) return;

  try {
    const body = JSON.parse(buf.toString(encoding));
    if (body && (body.masterKey || body._MasterKey)) {
      req['x-master-key'] = body.masterKey || body._MasterKey;
    }
  } catch {
    /*
     * The body mentions a master key but will not parse.
     *
     * This used to both send a 400 AND throw, which left Express reporting
     * "Cannot set headers after they are sent" on top of the real problem.
     * Throwing alone is right: body-parser catches it and answers, so the
     * caller gets one clean response and the log shows one cause.
     *
     * The status is set explicitly because body-parser wraps a `verify`
     * failure as `createError(403, err)` — a 403 for a malformed body, and a
     * silent change from the 400 this used to send. `http-errors` keeps a
     * status already on the error, so this restores it.
     */
    const error = new Error('Error parsing JSON body');
    (error as Error & {status: number}).status = 400;
    throw error;
  }
}

/**
 * Whether this request carries the master key.
 *
 * Two channels. The **header** is the one to use: it is where every Parse client
 * already puts it, it never lands in a request-body log, and it survives a route
 * that does not parse a body at all.
 *
 * The **body** channel is the original one and still works, so nothing that
 * relies on it breaks — but it is deprecated and will be removed. A secret in a
 * JSON body is a secret in every log, proxy and error report that ever echoes
 * that body.
 *
 * An unset `masterKey` env var never matches, so a misconfigured server fails
 * closed rather than letting every request through as master.
 */
/**
 * Compare two secrets without leaking their contents through timing.
 *
 * `===` on strings stops at the first differing character, so how long it takes
 * to fail is a function of how much of the key was right. Given enough samples
 * that is enough to recover a key one character at a time.
 *
 * `timingSafeEqual` needs equal-length buffers, so the length is checked first
 * — that does leak the key's length, which is not worth defending and cannot be
 * avoided here.
 */
function secretsMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

function hasMasterKey(req: any): boolean {
  const expected = kitConfig().masterKey;
  if (!expected) return false;

  if (secretsMatch(req.headers?.['x-parse-master-key'], expected)) return true;

  if (secretsMatch(req['x-master-key'], expected)) {
    if (!warnedBodyMasterKey) {
      warnedBodyMasterKey = true;
      console.warn(
        '[Security] Master key received in the request body. This is deprecated ' +
          'and will be removed — send it as the X-Parse-Master-Key header instead. ' +
          'A key in the body ends up in any log that records request bodies.'
      );
    }
    return true;
  }

  return false;
}

let warnedBodyMasterKey = false;

/**
 * Parse's authentication endpoints, and the method each is reachable with.
 *
 * `POST /users` is signup and is fine to expose. `GET /users` is a query
 * against the whole user table and is not, so the method is part of the match
 * rather than the path alone.
 */
const AUTH_ROUTES: {path: string; methods: string[]}[] = [
  {path: '/login', methods: ['GET', 'POST']},
  {path: '/logout', methods: ['POST']},
  {path: '/users', methods: ['POST']},
  {path: '/users/me', methods: ['GET']},
  {path: '/sessions/me', methods: ['GET']},
  {path: '/requestPasswordReset', methods: ['POST']},
  {path: '/verificationEmailRequest', methods: ['POST']},
];

function isAuthRoute(req: any): boolean {
  const method = String(req.method || '').toUpperCase();
  return AUTH_ROUTES.some(
    route => req.path === route.path && route.methods.includes(method)
  );
}

/**
 * Restricts access to internal Parse Server endpoints.
 *
 * Only entity routes, system routes, and rewritten `/functions` routes pass
 * through. Direct `/classes`, `/schemas` and `/batch` access is blocked, so a
 * client cannot go around the cloud functions you declared and query whatever
 * it likes.
 *
 * Parse's **auth endpoints are blocked too** — `/login`, signup, password
 * reset. That is deliberate: the documented approach is to expose the ones you
 * want as cloud functions, which gives you a place to put rate limiting,
 * lockout and audit logging. It is also the single most surprising thing this
 * middleware does, so the 403 below says so rather than leaving you to guess.
 * Set `configureKit({allowAuthRoutes: true})` to open them, which apps built on
 * Parse's official client SDKs need.
 */
export function restrictRoutes(req: any, res: Response, next: NextFunction) {
  const systemRoutes = ['/health', '/serverInfo', '/files'];

  // Master key bypasses all restrictions
  if (hasMasterKey(req)) {
    return next();
  }

  // Allow system routes
  if (systemRoutes.some(route => isUnderPrefix(req.path, route))) {
    return next();
  }

  // Allow registered entity route prefixes
  if (RouteRegistry.isRegisteredPrefix(req.path)) {
    return next();
  }

  /*
   * `/functions/{name}` — where validateEntityRoutes rewrites entity routes to,
   * and also reachable directly.
   *
   * The rate limit used to be skipped here, because it is applied in
   * validateEntityRoutes, which returns early for anything that is not a
   * registered entity prefix. So `rateLimit: {max: 2}` could be called any
   * number of times just by asking for `/api/functions/thatName` instead.
   * That is a genuine bypass with no legitimate use, so the limiter follows.
   *
   * The declared `methods` deliberately do NOT follow.
   *
   * `/functions/{name}` is Parse's own protocol endpoint, and every official
   * SDK's `Parse.Cloud.run` POSTs to it — always, whatever the function does.
   * `methods` describes the REST facade this library puts in FRONT of that
   * (`GET /api/widgets/listWidgets`). Enforcing it here would 405 every
   * GET-declared function called through `Cloud.run`, starting with the
   * generated project's own `listNotes`.
   *
   * Role checks and `requiresAuth` were never affected either way — those live
   * in the handler wrapper and run whichever path the caller took.
   *
   * A request the entity middleware already rewrote carries
   * `_entityRouteHandled` and has been counted once; counting it again would
   * charge the limiter twice for one call.
   *
   * Exact segment match, so `/functionsX` is not treated as a function route.
   */
  if (isUnderPrefix(req.path, '/functions')) {
    if ((req as any)._entityRouteHandled) return next();

    const functionName = req.path.slice('/functions/'.length).split('/')[0];
    const metadata = functionName
      ? CloudFunctionRegistry.getFunction(functionName)
      : undefined;

    // Unknown name: let Parse Server answer, as it did before.
    if (metadata?.config.rateLimit) {
      const allowed = checkRateLimit(req, res, functionName, metadata.config.rateLimit);
      if (!allowed) return; // 429 already sent
    }

    return next();
  }

  const authRoute = isAuthRoute(req);
  if (authRoute && kitConfig().allowAuthRoutes) {
    return next();
  }

  // `message` is unchanged — anything already matching on it keeps working.
  // `detail` is added because "Route not allowed" gives a caller nothing to act
  // on, and this middleware is the reason for a whole class of confused
  // bug reports.
  return res.status(403).json({
    message: 'Route not allowed',
    detail: authRoute
      ? `${req.method} ${req.path} is one of Parse's built-in auth endpoints, which ` +
        'restrictRoutes blocks by default. Either expose it as a cloud function, or ' +
        'call configureKit({allowAuthRoutes: true}) if your client uses a Parse SDK.'
      : `${req.method} ${req.path} is not a registered route. restrictRoutes allows ` +
        'your @Route prefixes, /functions, /health, /serverInfo and /files. Direct ' +
        '/classes, /schemas and /batch access is blocked by design.',
  });
}

/**
 * One parser, built once at import.
 *
 * A body-parser instance carries no per-request state — `app.use(express.json())`
 * is the intended usage. Calling the factory inside the handler rebuilt it on
 * every single request, which is pure allocation for no behavioural difference.
 */
const jsonParser = express.json({
  limit: '10mb',
  type: ['text/plain'],
  verify: extractMasterKey,
});

/**
 * Conditionally applies JSON parsing middleware, skipping file upload routes.
 *
 * The mount path is resolved per-request rather than at import, so a value set
 * later — by `configureKit()`, or by `dotenv` populating the environment — is
 * still honoured.
 */
export function conditionalJsonMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (req.path.startsWith(`${kitConfig().mountPath}/files`)) {
    return next();
  }

  return jsonParser(req, res, next);
}

/**
 * Removes the {result: ...} wrapper from Parse Server cloud function responses.
 * Applied unconditionally — Parse always wraps cloud function results.
 */
export function removeResultMiddleware(req: any, res: any, next: any) {
  const originalJson = res.json.bind(res);

  res.json = (body: any) => {
    if (body && typeof body === 'object' && 'result' in body) {
      return originalJson(body.result);
    }
    return originalJson(body);
  };

  next();
}
