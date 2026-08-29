import {currentSession} from './context';

/**
 * Where each driver method keeps its options argument.
 *
 * Both the injection table and the allowlist: a method that is not here is
 * passed through untouched, which is what keeps index management, change
 * streams and `drop` out of a transaction.
 *
 * `estimatedDocumentCount` is left out **deliberately**. Parse's own
 * `MongoCollection.count()` switches to it whenever the query is empty, and
 * MongoDB refuses the `count` command inside a transaction — joining one would
 * break every unfiltered count. The price is that such a count reads outside
 * the transaction's snapshot, which is the lesser problem.
 *
 * Exported so the integration tests can verify, against the driver parse-server
 * actually ships, that every position here is still where the options live.
 */
export const OPTIONS_ARGUMENT: Readonly<Record<string, number>> = {
  updateOne: 2,
  updateMany: 2,
  findOneAndUpdate: 2,
  findOneAndDelete: 1,
  replaceOne: 2,
  distinct: 2,
  insertOne: 1,
  insertMany: 1,
  deleteOne: 1,
  deleteMany: 1,
  find: 1,
  findOne: 1,
  aggregate: 1,
  countDocuments: 1,
};

/**
 * Classes that must never be dragged into somebody's transaction.
 *
 * Parse writes these as a side effect of ordinary work — creating a class on
 * first insert, recording an idempotency key — and they have to survive whether
 * or not the work does. A rolled-back schema would be worse than useless.
 */
export const NO_AMBIENT_TRANSACTION: ReadonlySet<string> = new Set([
  '_SCHEMA',
  '_Idempotency',
  '_Hooks',
  '_JobStatus',
  '_GlobalConfig',
]);

type DriverCollection = Record<string, unknown>;

/**
 * A driver collection that joins whatever transaction the caller is in.
 *
 * The session is read at **call** time rather than when the collection is
 * wrapped, because one collection object serves every caller and only the call
 * knows whose transaction it belongs to.
 *
 * A session already threaded through by hand wins, so Parse Server's own
 * transactional paths keep working untouched.
 */
export function withAmbientSession<T extends DriverCollection>(raw: T): T {
  return new Proxy(raw, {
    get(target, property) {
      const optionsIndex = OPTIONS_ARGUMENT[property as string];

      if (optionsIndex === undefined) {
        const value = target[property as string];
        return typeof value === 'function' ? value.bind(target) : value;
      }

      return (...args: unknown[]) => {
        const session = currentSession();
        if (session) {
          const options = {
            ...((args[optionsIndex] as Record<string, unknown>) ?? {}),
          };
          options.session ??= session;
          if (options.session === session) {
            // A transaction reads from the primary; anything else is refused.
            delete options.readPreference;
          }
          args[optionsIndex] = options;
        }
        return (target[property as string] as (...a: unknown[]) => unknown)(
          ...args
        );
      };
    },
  }) as T;
}
