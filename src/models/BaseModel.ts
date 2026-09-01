import {kitConfig} from '../config';

/**
 * Build a pointer to `targetClass` from whatever the client sent.
 *
 * Four shapes reach this in practice, and all four are legitimate:
 *
 *   "abc123"                                        a bare id — what a browser
 *                                                   sends for a select field
 *   {objectId: "abc123"}
 *   {id: "abc123"}
 *   {__type: "Pointer", className: "X", objectId: "abc123"}   Parse's own JSON
 *
 * The bare id used to fall through every branch and produce a pointer with
 * `id: undefined` — an object that looks right, saves without complaint, and
 * matches no query ever. That is precisely the class of silent failure this
 * library exists to remove, so an id that cannot be resolved now throws.
 */
function buildPointer(targetClass: string, value: any, field: string): Parse.Object {
  const id =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? value.objectId ?? value.id
        : undefined;

  if (typeof id !== 'string' || id === '') {
    throw new Parse.Error(
      Parse.Error.INVALID_POINTER,
      `Cannot build a ${targetClass} pointer for "${field}": expected an id string ` +
        `or an object with objectId/id, got ${JSON.stringify(value)}`
    );
  }

  const PointerConstructor = Parse.Object.extend(targetClass);
  const pointer = new PointerConstructor();
  pointer.id = id;
  return pointer;
}

/**
 * Say — once, and only outside production — that a field was thrown away.
 *
 * The discard itself is silent by design. Refusing the request would tell an
 * attacker exactly which fields are protected, and would break a client that is
 * merely out of date; neither is worth it, and the value does not land either
 * way.
 *
 * But there is a third caller, and silence serves them badly: the developer who
 * wired a form to send `status`, watched the request return 200, and cannot see
 * why the value never arrives. This is for them, which is why it is gated on
 * NODE_ENV rather than switched off entirely.
 *
 * Once per class and field, because a busy dev server would otherwise print it
 * on every request until the log is useless.
 */
const warnedDiscards = new Set<string>();

function warnDiscarded(className: string, field: string): void {
  if (process.env.NODE_ENV === 'production') return;

  const key = `${className}.${field}`;
  if (warnedDiscards.has(key)) return;
  warnedDiscards.add(key);

  console.warn(
    `[fromParams] Ignored '${field}' from the request body: ${key} is declared ` +
      'clientWritable: false. Set it in your own code if the server should ' +
      'choose it. (Development only — this is silent in production.)'
  );
}

const ParseObject = Parse.Object as unknown as new (className?: string) => Parse.Object;

export class BaseModel extends ParseObject {
  /**
   * Pointer target classes this model skips in `fromParams`.
   *
   * Left unset, the library-wide list applies — `['IMG', 'File']` by default,
   * changeable with `configureKit({excludedPointerClasses})`. Set it on a model
   * to override that for this model alone:
   *
   * ```ts
   * class Article extends BaseModel {
   *   protected static EXCLUDED_POINTER_CLASSES = ['Attachment'];
   * }
   * ```
   *
   * These are classes whose pointers need handling of their own, so building
   * one straight from request params would be wrong.
   */
  protected static EXCLUDED_POINTER_CLASSES: string[] | undefined = undefined;

  /** This model's exclusions, falling back to the library-wide setting. */
  private static excludedPointerClasses(): string[] {
    return this.EXCLUDED_POINTER_CLASSES ?? kitConfig().excludedPointerClasses;
  }

  static pointer<T extends typeof BaseModel>(this: T, id: string): InstanceType<T> {
    const obj = new this() as InstanceType<T>;
    obj.id = id;
    return obj;
  }

  static fromParams<T extends typeof BaseModel>(
    this: T,
    params: any
  ): InstanceType<T> {
    const fieldsMeta = Reflect.getMetadata('parse:fields', this) || {};

    /*
     * Strip anything the client is not allowed to set, BEFORE building the
     * object.
     *
     * This has to happen here rather than in the loop below, because
     * `Parse.Object.fromJSON` assigns every key it is given. Filtering
     * afterwards would only skip re-setting a value that was already on the
     * object — which looks like protection and is not.
     */
    const source: Record<string, unknown> = {};
    for (const key of Object.keys(params ?? {})) {
      if (fieldsMeta[key]?.clientWritable === false) {
        warnDiscarded(this.name, key);
        continue;
      }
      source[key] = params[key];
    }
    // A copy, so this never writes `className` into the caller's `req.params`.
    // Mutating the request object meant a second call — a retried transaction,
    // say — saw an input the first call had already altered.
    source.className = new this().className;

    const raw = Parse.Object.fromJSON(source, true);
    Object.setPrototypeOf(raw, this.prototype);
    const obj = raw as InstanceType<T>;

    if (params.id) obj.id = params.id;

    const excluded = this.excludedPointerClasses();

    for (const field in fieldsMeta) {
      const fieldMeta = fieldsMeta[field];
      const fieldType = fieldMeta.type;
      const targetClass = fieldMeta.targetClass;
      const value = params[field];

      if (value === undefined) {
        continue;
      }

      /*
       * A field the client is not allowed to choose.
       *
       * Without this, every declared field is settable from the request body —
       * which is mass assignment. `createNote` accepting `{"title": "…"}` also
       * accepts `{"title": "…", "status": "published", "views": 9999}`, and
       * nothing objects: the row saves with values the caller was never meant
       * to pick, no error, no log.
       *
       * Silently skipped rather than rejected, deliberately. A client that
       * sends a field it should not is usually a stale app or a hopeful one,
       * not something worth failing a request over — and the outcome is the
       * same either way: the value is not used. Your own code is untouched;
       * this governs `fromParams`, not the field.
       */
      if (fieldMeta.clientWritable === false) {
        continue;
      }

      // Check exclusion list (per-model override, else the library setting)
      if (targetClass && excluded.includes(targetClass)) {
        continue;
      }

      // Pointer field
      if (fieldType === 'Pointer') {
        if (
          value === null ||
          (value &&
            typeof value === 'object' &&
            Object.keys(value).length === 0)
        ) {
          obj.set(field, null);
          continue;
        }

        obj.set(field, buildPointer(targetClass, value, field));
        continue;
      }

      // Array of Pointers
      if (fieldType === 'Array' && Array.isArray(value) && targetClass) {
        obj.set(
          field,
          value.map((item: any) => buildPointer(targetClass, item, field))
        );
        continue;
      }

      // Embedded object
      if (fieldType === 'Object') {
        obj.set(field, value);
        continue;
      }

      if (fieldType === 'Date') {
        obj.set(field, new Date(value));
        continue;
      }
      if (fieldType === 'GeoPoint') {
        obj.set(field, new Parse.GeoPoint(value));
        continue;
      }
      // Scalar
      obj.set(field, value);
    }

    return obj;
  }
}
