import {ParseField, onClassRegistered} from '../decorators/parseDecorators';

/**
 * Optimistic locking, declared on the field rather than written into functions.
 *
 * Two people reading the same record and both saving is a lost update: the
 * second write silently overwrites the first, and neither is told. Guarding
 * against it in every cloud function means remembering to, every time, forever.
 *
 * `@ParseVersionField()` moves the guard under the endpoints. It does three
 * things:
 *
 *   1. declares the field as a normal `Number` on the schema;
 *   2. records that this class is versioned, and by which field, so the
 *      database adapter can find it;
 *   3. makes every object read from the database carry the version it read, so
 *      a later save asserts it without anybody asking.
 *
 * The database then does the checking — see `versionedMongoAdapter.ts`. An
 * endpoint neither reads nor writes the field.
 */

/** Where a class parks its version field until `@ParseClass` names the class. */
const PENDING_VERSION_FIELD = Symbol.for('fsm:pendingVersionField');

/** className → the field that carries its version. */
const versionedClasses = new Map<string, string>();

// `@ParseField` runs before `@ParseClass`, so the field is known before the
// class name is. This hook is where the two meet.
onClassRegistered((className, constructor) => {
  const field = (constructor as unknown as Record<symbol, string>)[
    PENDING_VERSION_FIELD
  ];
  if (field) {
    versionedClasses.set(className, field);
  }
});

/** Set once `createVersionedMongoAdapter` has actually built the adapter. */
let adapterInstalled = false;

export const VersionRegistry = {
  /** The version field of this class, or nothing if it is not versioned. */
  fieldFor(className: string): string | undefined {
    return versionedClasses.get(className);
  },

  isVersioned(className: string): boolean {
    return versionedClasses.has(className);
  },

  /** Every versioned class, for tests and for reporting at boot. */
  classNames(): string[] {
    return [...versionedClasses.keys()];
  },

  /** Told by `createVersionedMongoAdapter`, so `verify` can spot its absence. */
  markAdapterInstalled(): void {
    adapterInstalled = true;
  },

  adapterIsInstalled(): boolean {
    return adapterInstalled;
  },

  /**
   * Say so, at boot, if optimistic locking has been asked for but cannot work.
   *
   * `@ParseVersionField` does nothing on its own — the guarding lives in the
   * database adapter. Declare the field, forget the adapter (or run on
   * Postgres, which this does not support), and every save proceeds unguarded
   * with no error and no log: the exact shape of failure a lock is supposed to
   * prevent. This turns that silence into a line in the boot output.
   *
   * Called from `CloudFunctionRegistry.initialize()`, which consumers already
   * run after the server is configured — by then both the models and the
   * adapter are known.
   */
  verify(): void {
    const versioned = this.classNames();
    if (versioned.length === 0) return;

    if (!adapterInstalled) {
      console.warn(
        `[Versioning] ${versioned.length} class(es) declare @ParseVersionField ` +
          `(${versioned.join(', ')}), but createVersionedMongoAdapter() was never called. ` +
          'Optimistic locking is INACTIVE — stale saves will overwrite silently. ' +
          'Pass the adapter to ParseServer via `databaseAdapter`, and note that ' +
          'this feature is MongoDB-only.'
      );
      return;
    }

    console.log(
      `[Versioning] Optimistic locking active on: ${versioned.join(', ')}`
    );
  },
};

/**
 * Put the version this copy was read at into the payload of every save.
 *
 * A Parse save sends only the fields that changed, and a version nobody touched
 * is not one of them — so the database would have nothing to check against.
 *
 * The hook is the payload rather than the object. Marking the field dirty on
 * read would work too, but it leaves the object permanently dirty, and Parse
 * then serializes it as a bare pointer in a cloud function response — every
 * job in a list would come back as `{__type, className, objectId}` and nothing
 * else. Building the assertion at save time instead touches no state at all.
 *
 * `_getSaveJSON` is what both `save()` and `saveAll()` call to build a request
 * body, which is why an endpoint never has to do this itself.
 */
function assertVersionOnSave(prototype: object, field: string): void {
  const inherited = (
    prototype as unknown as {_getSaveJSON?: () => Record<string, unknown>}
  )._getSaveJSON;
  if (typeof inherited !== 'function') {
    // The one place this feature leans on a Parse SDK internal. If the SDK ever
    // moves it, locking would quietly stop asserting anything — so say so here
    // rather than let it degrade in silence.
    console.warn(
      '[Versioning] Parse.Object.prototype._getSaveJSON not found — this Parse ' +
        'SDK version is not compatible with @ParseVersionField. Optimistic ' +
        'locking is INACTIVE for this class; saves will not assert a version.'
    );
    return;
  }

  Object.defineProperty(prototype, '_getSaveJSON', {
    value: function (this: Parse.Object) {
      const body = inherited.call(this);
      // A create has nothing to assert against; the adapter gives it its first
      // version. An object built from an id rather than read has no version to
      // assert, and is simply not protected.
      if (this.id) {
        const version = this.get(field);
        if (typeof version === 'number') {
          body[field] = version;
        }
      }
      return body;
    },
    writable: true,
    configurable: true,
  });
}

/**
 * Mark this field as the class's version.
 *
 * Applies `@ParseField` itself, so the field is declared once. Nothing else in
 * the codebase reads or writes it: the adapter increments it on every update,
 * and refuses an update whose asserted version is no longer the current one.
 */
export function ParseVersionField(
  options: {description?: string} = {}
): (target: object, propertyKey: string | symbol) => void {
  return (target: object, propertyKey: string | symbol) => {
    const field = String(propertyKey);

    ParseField({
      type: 'Number',
      // Set by the adapter when the row is created, so a caller never supplies
      // one and a create that omits it is not a validation failure.
      required: false,
      description:
        options.description ??
        'Row version. Incremented on every update; a save asserting a stale one is refused',
    })(target, propertyKey);

    const constructor = target.constructor as unknown as Record<symbol, string>;
    constructor[PENDING_VERSION_FIELD] = field;

    assertVersionOnSave(target, field);
  };
}
