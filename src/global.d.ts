/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Minimal Parse type declarations for the library.
 * The consuming project (with parse-server installed) provides full types at runtime.
 */
declare namespace Parse {
  class Object {
    constructor(className?: string);
    id: string;
    className: string;
    get(key: string): any;
    set(key: string | Record<string, any>, value?: any): this;
    save(attrs?: any, options?: any): Promise<this>;
    destroy(options?: any): Promise<this>;
    toJSON(): Record<string, any>;
    setACL(acl: ACL): void;
    getACL(): ACL | undefined;
    static registerSubclass(className: string, constructor: new (...args: any[]) => any): void;
    static extend(className: string): new (...args: any[]) => Parse.Object;
    static fromJSON(json: any, override?: boolean): Parse.Object;
  }

  class User extends Object {
    getUsername(): string;
    setUsername(username: string): void;
    setPassword(password: string): void;
    setEmail(email: string): void;
    getSessionToken(): string;
  }

  class Role extends Object {
    getName(): string;
    getUsers(): Relation;
    getRoles(): Relation;
  }

  class ACL {
    constructor(user?: any);
    setPublicReadAccess(allowed: boolean): void;
    setPublicWriteAccess(allowed: boolean): void;
    setRoleReadAccess(role: string, allowed: boolean): void;
    setRoleWriteAccess(role: string, allowed: boolean): void;
    setReadAccess(userId: any, allowed: boolean): void;
    setWriteAccess(userId: any, allowed: boolean): void;
    // The getters exist on the real SDK and were missing here, so asking an
    // ACL what it currently grants did not compile — which matters when a
    // trigger needs to preserve one grant while rewriting the rest.
    getPublicReadAccess(): boolean;
    getPublicWriteAccess(): boolean;
    getRoleReadAccess(role: string): boolean;
    getRoleWriteAccess(role: string): boolean;
    getReadAccess(userId: any): boolean;
    getWriteAccess(userId: any): boolean;
    toJSON(): Record<string, { read?: boolean; write?: boolean }>;
  }

  class Query {
    constructor(className: string | (new (...args: any[]) => any));
    equalTo(key: string, value: any): this;
    notEqualTo(key: string, value: any): this;
    containedIn(key: string, values: any[]): this;
    notContainedIn(key: string, values: any[]): this;
    exists(key: string): this;
    doesNotExist(key: string): this;
    greaterThan(key: string, value: any): this;
    greaterThanOrEqualTo(key: string, value: any): this;
    lessThan(key: string, value: any): this;
    lessThanOrEqualTo(key: string, value: any): this;
    startsWith(key: string, prefix: string): this;
    endsWith(key: string, suffix: string): this;
    contains(key: string, substring: string): this;
    fullText(key: string, value: string): this;
    include(keys: string | string[]): this;
    select(...keys: string[]): this;
    ascending(...keys: string[]): this;
    descending(...keys: string[]): this;
    addAscending(...keys: string[]): this;
    addDescending(...keys: string[]): this;
    limit(n: number): this;
    /** Return {results, count} from find() instead of an array. */
    withCount(value?: boolean): this;
    skip(n: number): this;
    find(options?: any): Promise<any[]>;
    first(options?: any): Promise<any>;
    count(options?: any): Promise<number>;
    get(objectId: string, options?: any): Promise<any>;
    each(callback: (obj: any) => any, options?: any): Promise<void>;
    aggregate(pipeline: any, options?: any): Promise<any[]>;
    subscribe(sessionToken?: string): Promise<any>;
    static or(...queries: Query[]): Query;
    static and(...queries: Query[]): Query;
    matches(key: string, regex: RegExp): this;
    matchesQuery(key: string, query: Query): this;
  }

  class Relation {
    query(): Query;
  }

  class File {
    constructor(name: string, data: any, type?: string);
    save(options?: any): Promise<File>;
    /** The stored name, which Parse prefixes to keep it unique. */
    name(): string;
    url(options?: {forceSecure?: boolean}): string;
    destroy(options?: any): Promise<File>;
    getData(): Promise<string>;
  }

  class GeoPoint {
    constructor(arg: any);
  }

  class Error {
    constructor(code: number, message: string);
    readonly code: number;
    readonly message: string;
    // The codes this library or its callers actually throw. Parse defines many
    // more; these are declared because using one should not require a cast.
    static OBJECT_NOT_FOUND: number; // 101
    static INVALID_QUERY: number; // 102
    static INVALID_CLASS_NAME: number; // 103
    static MISSING_OBJECT_ID: number; // 104
    static INVALID_KEY_NAME: number; // 105
    static INVALID_POINTER: number; // 106
    static INVALID_JSON: number; // 107
    static OPERATION_FORBIDDEN: number; // 119
    static OTHER_CAUSE: number; // -1
    static SCRIPT_FAILED: number; // 141
    static VALIDATION_ERROR: number; // 142
    static INVALID_SESSION_TOKEN: number; // 209
    static INTERNAL_SERVER_ERROR: number; // 1
  }

  namespace Cloud {
    interface FunctionRequest {
      params: any;
      user?: User;
      master?: boolean;
    }

    interface BeforeSaveRequest<T = Object> { object: T; original?: T; user?: User; master?: boolean; }
    interface AfterSaveRequest<T = Object> { object: T; original?: T; user?: User; master?: boolean; }
    interface BeforeDeleteRequest<T = Object> { object: T; user?: User; master?: boolean; }
    interface AfterDeleteRequest<T = Object> { object: T; user?: User; master?: boolean; }
    interface BeforeFindRequest<T = Object> { query: Query; user?: User; master?: boolean; }
    interface AfterFindRequest<T = Object> { objects: T[]; query: Query; user?: User; master?: boolean; }

    type Validator = Record<string, any>;

    function define(name: string, handler: (req: FunctionRequest) => any, validator?: Validator): void;
    function beforeSave(className: string, handler: any, validator?: any): void;
    function afterSave(className: string, handler: any, validator?: any): void;
    function beforeDelete(className: string, handler: any, validator?: any): void;
    function afterDelete(className: string, handler: any, validator?: any): void;
    function beforeFind(className: string, handler: any, validator?: any): void;
    function afterFind(className: string, handler: any, validator?: any): void;
    function beforeLogin(handler: any): void;
    function afterLogin(handler: any, validator?: any): void;
    function afterLogout(handler: any, validator?: any): void;
    function beforeSaveFile(handler: any, validator?: any): void;
    function afterSaveFile(handler: any, validator?: any): void;
    function beforeDeleteFile(handler: any, validator?: any): void;
    function afterDeleteFile(handler: any, validator?: any): void;
  }

  let masterKey: string | undefined;
}

declare module 'swagger-ui-express' {
  const swaggerUi: any;
  export = swaggerUi;
}

declare module 'node-cron' {
  function validate(expression: string): boolean;
  function schedule(expression: string, func: () => void, options?: any): { start(): void; stop(): void };
}
