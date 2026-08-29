import {
  NO_AMBIENT_TRANSACTION,
  withAmbientSession,
} from '../transactions/ambientSession';
import {
  CONFLICT,
  CONFLICT_MESSAGE,
  useTransactionAdapter,
} from '../transactions/context';
import {VersionRegistry} from './versionRegistry';

/**
 * A save that lost a race, under the one code every conflict reports.
 *
 * Shared with the transaction layer deliberately: losing an optimistic lock and
 * losing a transaction's race are the same event to whoever is looking at it.
 */
export const VERSION_CONFLICT = CONFLICT;
export const VERSION_CONFLICT_MESSAGE = CONFLICT_MESSAGE;

export type MongoAdapterConstructor = new (options: unknown) => {
  _adaptiveCollection(
    className: string
  ): Promise<{_mongoCollection: Record<string, unknown>}>;
  connect(): Promise<unknown>;
  createTransactionalSession(): Promise<unknown>;
  commitTransactionalSession(session: unknown): Promise<unknown>;
  abortTransactionalSession(session: unknown): Promise<unknown>;
  findOneAndUpdate(
    className: string,
    schema: unknown,
    query: Record<string, unknown>,
    update: Record<string, unknown>,
    transactionalSession?: unknown
  ): Promise<unknown>;
  createObject(
    className: string,
    schema: unknown,
    object: Record<string, unknown>,
    transactionalSession?: unknown
  ): Promise<unknown>;
  find(
    className: string,
    schema: unknown,
    query: Record<string, unknown>,
    options: Record<string, unknown>
  ): Promise<unknown[]>;
};

/** What `createVersionedMongoAdapter` hands back, structurally. */
export type VersionedMongoAdapter = InstanceType<MongoAdapterConstructor>;

/**
 * Load the adapter Parse Server ships with, to extend rather than replace.
 *
 * Required lazily so the class is only built when the server is being
 * configured — importing `parse-server` at module load would pull the whole
 * server into every unit test that touches a model.
 */
function baseAdapter(): MongoAdapterConstructor {
  // Not exported from the package root, only from its own module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    MongoStorageAdapter,
  } = require('parse-server/lib/Adapters/Storage/Mongo/MongoStorageAdapter');
  return MongoStorageAdapter as MongoAdapterConstructor;
}

/**
 * The database adapter that makes `@ParseVersionField` mean something.
 *
 * Parse turns an object update into exactly one `findOneAndUpdate`, so that is
 * the one place where a conditional write can be made to cover every save in
 * the system — cloud function, trigger or REST — without a single endpoint
 * knowing about it.
 *
 * For a versioned class it does two things to the update Parse built:
 *
 *   - moves the asserted version out of the update and into the **filter**, so
 *     the write only lands if the row is still at the version the caller read;
 *   - replaces it with an increment, so the row always moves on and the next
 *     reader gets a fresh number.
 *
 * When the filter matches nothing it asks whether the row exists at all, so a
 * lost race is reported as a conflict and a genuinely missing row still reads
 * as missing.
 *
 * Only the single-object path is guarded. `updateObjectsByQuery` (a `many`
 * update) and `upsertOneObject` are untouched: neither is reached by an object
 * save, and a bulk update has no one version to assert.
 *
 * It carries the ambient transaction too. Both jobs meet in the same place for
 * the same reason: this is the one point every write in the system passes
 * through, whichever endpoint, trigger or SDK call started it.
 */
export function createVersionedMongoAdapter(
  options: unknown
): VersionedMongoAdapter {
  const MongoStorageAdapter = baseAdapter();

  // Named differently from the exported `VersionedMongoAdapter` type so the
  // function's declared return type keeps pointing at the public alias.
  class VersionedAdapter extends MongoStorageAdapter {
    async findOneAndUpdate(
      className: string,
      schema: unknown,
      query: Record<string, unknown>,
      update: Record<string, unknown>,
      transactionalSession?: unknown
    ): Promise<unknown> {
      const field = VersionRegistry.fieldFor(className);
      if (!field) {
        return super.findOneAndUpdate(
          className,
          schema,
          query,
          update,
          transactionalSession
        );
      }

      // A number here is the caller saying "this is what I read". Anything else
      // — absent, or an operator — is not an assertion, and the row is only
      // moved on.
      const asserted = update[field];
      const hasAssertion = typeof asserted === 'number';

      const guardedUpdate = {
        ...update,
        [field]: {__op: 'Increment', amount: 1},
      };
      const guardedQuery = hasAssertion ? {...query, [field]: asserted} : query;

      const result = await super.findOneAndUpdate(
        className,
        schema,
        guardedQuery,
        guardedUpdate,
        transactionalSession
      );
      if (result || !hasAssertion) return result;

      // Nothing matched. Either somebody moved it on, or it is gone.
      if (await this.rowExists(className, schema, query)) {
        // The typings only admit Parse's own codes; the wire format is a
        // number, and a code of our own is what keeps this distinguishable
        // from every meaning Parse already has.
        throw new Parse.Error(VERSION_CONFLICT, VERSION_CONFLICT_MESSAGE);
      }
      return result;
    }

    /**
     * Give a new row its first version.
     *
     * Creates never reach `findOneAndUpdate`, so without this the first update
     * of a row would have nothing to assert against.
     */
    createObject(
      className: string,
      schema: unknown,
      object: Record<string, unknown>,
      transactionalSession?: unknown
    ): Promise<unknown> {
      const field = VersionRegistry.fieldFor(className);
      const versioned =
        field && typeof object[field] !== 'number'
          ? {...object, [field]: 1}
          : object;

      return super.createObject(
        className,
        schema,
        versioned,
        transactionalSession
      );
    }

    /**
     * Every collection joins whatever transaction its caller is in.
     *
     * The wrapping is per call rather than cached, because `_adaptiveCollection`
     * hands back a fresh wrapper each time — so there is nothing to accumulate
     * proxies on.
     */
    _adaptiveCollection(
      className: string
    ): Promise<{_mongoCollection: Record<string, unknown>}> {
      return super._adaptiveCollection(className).then(collection => {
        if (!NO_AMBIENT_TRANSACTION.has(className)) {
          collection._mongoCollection = withAmbientSession(
            collection._mongoCollection
          );
        }
        return collection;
      });
    }

    /** Whether the row is there at all, ignoring what version it is at. */
    private async rowExists(
      className: string,
      schema: unknown,
      query: Record<string, unknown>
    ): Promise<boolean> {
      const rows = await this.find(className, schema, query, {limit: 1});
      return rows.length > 0;
    }
  }

  const instance = new VersionedAdapter(options);
  // What `withTransaction` opens, commits and aborts. It is told the adapter
  // rather than importing one, so it never learns what a session is.
  useTransactionAdapter(instance);
  // So a `@ParseVersionField` with no adapter behind it can be reported at boot
  // instead of failing to guard anything in silence.
  VersionRegistry.markAdapterInstalled();
  return instance;
}
