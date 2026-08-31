/**
 * The roles this application has.
 *
 * Declared once, here, because a role name is a string that has to agree in
 * four separate places — the schema's `adminRole`, the seed that creates it,
 * the CLP on every model, and the `requireRoles` on every endpoint. Written by
 * hand in each, a typo grants nothing at all: `roleKey('Editer')` is a
 * perfectly valid key for a role that does not exist, so the permission is
 * simply never matched. Nothing throws, and nothing is logged.
 *
 * As a const object, `Roles.EDITOR` is the literal type `'Editor'`, so
 * `roleKey(Roles.EDITOR)` is `'role:Editor'` and a misspelling is a compile
 * error rather than a silent hole in your permissions.
 *
 * This is what parse-server-kit's own docs ask for: its built-in `UserRoles`
 * enum is deprecated precisely because a library cannot know your roles, and
 * `roleKey()` is generic so that yours keep their literal types.
 *
 * Add a role by adding it here, then to `ROLE_HIERARCHY` below if it should
 * inherit another's permissions.
 */
export const Roles = {
  EDITOR: 'Editor',
  ADMIN: 'Admin',
} as const;

export type Role = (typeof Roles)[keyof typeof Roles];

/** Every role, for the seed to create. */
export const ALL_ROLES: Role[] = Object.values(Roles);

/**
 * Which roles contain which.
 *
 * `[child, parent]` means every member of `child` is also treated as a member
 * of `parent` — so `[Roles.ADMIN, Roles.EDITOR]` lets an Admin do everything
 * an Editor can.
 *
 * The direction is easy to reverse, and reversing it fails quietly: your Admin
 * is simply refused by Editor-gated endpoints, with nothing in the log to say
 * why. Read it as "ADMIN is inside EDITOR".
 */
export const ROLE_HIERARCHY: ReadonlyArray<readonly [Role, Role]> = [
  [Roles.ADMIN, Roles.EDITOR],
];

/**
 * The role allowed to manage the `_Role` class itself — create roles, change
 * who is in them. Kept separate from the list above because it answers a
 * different question: not "what roles exist" but "who administers them".
 */
export const SCHEMA_ADMIN_ROLE: Role = Roles.ADMIN;
