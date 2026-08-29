import {AsyncLocalStorage} from 'node:async_hooks';

/**
 * Transactions that follow the call, not the request.
 *
 * Parse Server has a transaction of its own, but it keeps the open session in a
 * single field on the shared `DatabaseController`, and every write in the
 * process passes that field to the adapter. One cloud function's transaction
 * therefore swallows every *unrelated* request running at the same moment, and
 * two of them collide outright.
 *
 * This one lives in an `AsyncLocalStorage` instead. The store follows the chain
 * of awaits belonging to one call and nothing else, so two callers each get
 * their own session and neither can see the other's. The database adapter reads
 * it at the moment it talks to the driver — see `ambientSession.ts` — which is
 * why a save inside the body joins without being told to.
 *
 * **This needs Parse Server's `directAccess`.** With it, a `save()` in cloud
 * code is handled in the same async context; without it the SDK sends itself an
 * HTTP request, which arrives in a fresh context with an empty store and writes
 * outside the transaction. `directAccess` defaults to true and the config pins
 * it, because that failure has no symptom.
 *
 * And it needs MongoDB to be a replica set. A standalone has no transactions
 * and refuses to open one.
 */

/**
 * One code for every "somebody else got there first".
 *
 * A lost optimistic lock and a transaction that lost its race are the same
 * event to whoever is looking at the screen, so they read the same. Parse has
 * no code of its own for a write conflict and every code it does have means
 * something else.
 */
type ParseErrorCode = ConstructorParameters<typeof Parse.Error>[0];

export const CONFLICT = 5001 as ParseErrorCode;

export const CONFLICT_MESSAGE =
  'Somebody else changed this while you were working on it. Open it again and redo your change.';

/** What one call is carrying. The session is the adapter's to understand. */
interface TransactionStore {
  session: unknown;
}

const storage = new AsyncLocalStorage<TransactionStore>();

/**
 * The four things this needs of a storage adapter.
 *
 * Deliberately structural and deliberately ignorant: the session is `unknown`
 * because what a transaction *is* belongs to the adapter, and nothing here
 * should be able to reach into one.
 */
export interface TransactionalAdapter {
  connect(): Promise<unknown>;
  createTransactionalSession(): Promise<unknown>;
  commitTransactionalSession(session: unknown): Promise<unknown>;
  abortTransactionalSession(session: unknown): Promise<unknown>;
}

let adapter: TransactionalAdapter | null = null;
let warnedWithoutAdapter = false;

/** Told once, when the adapter is built. */
export function useTransactionAdapter(value: TransactionalAdapter): void {
  adapter = value;
}

/** The session this call is running under, if it is running under one. */
export function currentSession(): unknown {
  return storage.getStore()?.session;
}

export function inTransaction(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * A write that lost a race with another transaction and may simply be retried.
 *
 * MongoDB labels these itself, and a write inside a transaction reports code
 * 251. Neither survives the trip up, though: the Mongo adapter classifies the
 * error first and rethrows it as a bare `INTERNAL_SERVER_ERROR` with the message
 * `Database error`, dropping the label and the code.
 *
 * So that message is the third thing checked. It reads like a guess and is not:
 * Parse Server produces that exact string in exactly one place, and only for an
 * error its own `isTransientError` has already classified — which is the same
 * question being asked here.
 */
const PARSE_TRANSIENT_MESSAGE = 'Database error';

function isTransient(error: unknown): boolean {
  const failure = error as {
    hasErrorLabel?: (label: string) => boolean;
    code?: number;
    message?: string;
  };
  if (failure?.hasErrorLabel?.('TransientTransactionError') === true)
    return true;
  if (failure?.code === 251) return true;
  return (
    failure?.code === Parse.Error.INTERNAL_SERVER_ERROR &&
    failure?.message === PARSE_TRANSIENT_MESSAGE
  );
}

/** How many times a body may be re-run after losing a race. */
const MAX_ATTEMPTS = 3;

/**
 * Run this, and either everything it wrote lands or none of it does.
 *
 * **Nested calls join.** A body already running inside a transaction simply
 * runs — MongoDB has no nested transactions, and the useful meaning of an inner
 * one is "take part in the outer". Committing is therefore the outermost
 * caller's job alone.
 *
 * A body may be **re-run** if the transaction lost a race with another one, so
 * it must be safe to repeat. Ours are: each reads the state it acts on at the
 * start, and anything it wrote on the failed attempt was rolled back with it.
 */
export async function withTransaction<T>(body: () => Promise<T>): Promise<T> {
  // Already inside one — take part in it rather than opening a second.
  if (inTransaction()) return body();

  if (!adapter) {
    if (!warnedWithoutAdapter) {
      warnedWithoutAdapter = true;
      console.warn(
        '[Transactions] No storage adapter registered — running without one. ' +
          'Writes will not be rolled back together.'
      );
    }
    return body();
  }

  // `createTransactionalSession` reaches straight for the driver's client, so
  // the very first transaction of the process has to wait for the connection.
  await adapter.connect();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const session = await adapter.createTransactionalSession();
    try {
      const result = await storage.run({session}, body);
      await adapter.commitTransactionalSession(session);
      return result;
    } catch (error) {
      await adapter.abortTransactionalSession(session).catch(() => undefined);
      if (!isTransient(error)) throw error;
    }
  }

  // Out of attempts, still losing. The caller is not interested in which lock
  // it was — only that somebody else is working on the same thing.
  throw new Parse.Error(CONFLICT, CONFLICT_MESSAGE);
}

/**
 * Everything this cloud function writes lands together, or none of it does.
 *
 * **Order matters.** `@CloudFunction` reads the method off the descriptor when
 * it is applied, and decorators apply bottom-up — so this must sit *below* it,
 * or the registry keeps the unwrapped method and the transaction silently never
 * opens:
 *
 * ```ts
 * @CloudFunction({...})   // sees the wrapped method
 * @Transactional()        // wraps it
 * async submitJob(req) {}
 * ```
 *
 * `withTransaction` is exported beside this for anything that is not a cloud
 * function, or for wrapping part of one by hand.
 */
export function Transactional() {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor => {
    const body = descriptor.value;
    if (typeof body !== 'function') {
      throw new Error('@Transactional can only be applied to methods.');
    }

    descriptor.value = function (this: unknown, ...args: unknown[]) {
      return withTransaction(() => body.apply(this, args));
    };
    return descriptor;
  };
}
