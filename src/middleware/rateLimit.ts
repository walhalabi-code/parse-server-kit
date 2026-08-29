import {Request, Response} from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// Map<functionName, Map<clientKey, RateLimitEntry>>
const store: Map<string, Map<string, RateLimitEntry>> = new Map();

// Cleanup old entries every 5 minutes
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [fnName, clients] of store) {
    for (const [key, entry] of clients) {
      if (now > entry.resetAt) {
        clients.delete(key);
      }
    }
    if (clients.size === 0) {
      store.delete(fnName);
    }
  }
}, 5 * 60 * 1000);

// A sweep of an in-memory map is never a reason to hold the process open.
// Without this, merely importing the kit keeps the event loop alive forever —
// a seed script, a migration or a Jest run would hang instead of exiting.
// The sweep still runs for as long as something else is keeping the process up,
// which is the only time it has anything to do.
cleanupTimer.unref();

/**
 * Get client key — session token if available, fallback to IP.
 */
function getClientKey(req: Request): string {
  return (req.headers['x-parse-session-token'] as string) || req.ip || 'unknown';
}

/**
 * Check rate limit for a function + client.
 * Returns null if allowed, or an error response object if exceeded.
 */
export function checkRateLimit(
  req: Request,
  res: Response,
  functionName: string,
  config: { windowMs: number; max: number }
): boolean {
  const clientKey = getClientKey(req);
  const now = Date.now();

  // Get or create function map
  if (!store.has(functionName)) {
    store.set(functionName, new Map());
  }
  const clients = store.get(functionName)!;

  // Get or create client entry
  const entry = clients.get(clientKey);

  if (!entry || now > entry.resetAt) {
    // First request or window expired — start fresh
    clients.set(clientKey, { count: 1, resetAt: now + config.windowMs });
    return true; // allowed
  }

  if (entry.count < config.max) {
    // Under limit
    entry.count++;
    return true; // allowed
  }

  // Exceeded — send 429
  const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
  res.set('Retry-After', String(retryAfter));
  res.status(429).json({
    message: `Too many requests. Try again in ${retryAfter} seconds.`,
    retryAfter,
  });
  return false; // blocked
}
