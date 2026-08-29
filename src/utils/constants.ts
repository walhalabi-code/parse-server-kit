/**
 * A Parse CLP/ACL role key — `'role:Editor'`, `'role:BusinessOwner'`.
 *
 * Generic over the role name so it keeps the literal type: given `'Editor'` it
 * is `'role:Editor'`, not merely `string`. Left unparameterised it accepts any
 * role, which is what a library that does not know your roles should do.
 */
export type RoleString<R extends string = string> = `role:${R}`;

/**
 * Build a role key for a CLP or an ACL.
 *
 * ```ts
 * enum Roles {ADMIN = 'Owner', MEMBER = 'Member'}   // your roles, not ours
 *
 * @ParseClass('Product', {
 *   clp: {find: {[roleKey(Roles.ADMIN)]: true}},
 * })
 * ```
 *
 * Takes any string, so it works with your own enum, a union of literals, or a
 * plain string — and returns the exact literal type, so a typo in a CLP key is
 * still a type error.
 */
export function roleKey<R extends string>(role: R): RoleString<R> {
  return `role:${role}`;
}

/**
 * Example roles, kept for backwards compatibility.
 *
 * @deprecated Define your own. A shop has sellers and buyers, a clinic has
 * doctors and nurses; this library has no business naming either. Declare an
 * enum in your project and pass it to {@link roleKey}, which accepts any
 * string:
 *
 * ```ts
 * export enum UserRoles {ADMIN = 'Owner', MEMBER = 'Member'}
 * ```
 *
 * This will be removed in the next major version.
 */
export enum UserRoles {
  ADMIN = 'SuperAdmin',
  EMPLOYEE = 'Employee',
}

/** Maximum limit for unbounded Parse queries */
export const MAX_QUERY_LIMIT = 10000;
