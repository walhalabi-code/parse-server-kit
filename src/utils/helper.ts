import {readCachedRoles, writeCachedRoles} from './roleCache';

export function formatCount(num: any, locale = 'en') {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(num ?? 0);
}

export function generateRandomPassword(
  length = 8,
  includeNumbers = true,
  includeSymbols = true
) {
  const lowerCaseChars = 'abcdefghijklmnopqrstuvwxyz';
  const upperCaseChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numberChars = '0123456789';
  const symbolChars = '!@#$%^&*()-_=+[]{}|;:,.<>?';

  let charSet = lowerCaseChars + upperCaseChars;
  if (includeNumbers) charSet += numberChars;
  if (includeSymbols) charSet += symbolChars;

  let password = '';
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * charSet.length);
    password += charSet[randomIndex];
  }
  return password;
}

export function generateRandomInteger(length: number) {
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  return (Math.floor(Math.random() * (max - min + 1)) + min).toString();
}

export function generateRandomString(length = 8): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function catchError<T>(
  promise: Promise<T>
): Promise<[undefined, T] | [Error]> {
  return promise
    .then(data => {
      return [undefined, data] as [undefined, T];
    })
    .catch(err => {
      return [err];
    });
}

/**
 * Get role names for a single user.
 *
 * Served from the role cache when one is configured; otherwise this is the same
 * query it has always been. See `configureRoleCache` — the cache is off unless
 * a deployment turns it on.
 */
export async function getUserRoles(user: Parse.User): Promise<string[]> {
  const cached = readCachedRoles(user.id!);
  if (cached) return cached;

  const roleQuery = new Parse.Query('_Role');
  roleQuery.equalTo('users', user);
  const roles = await roleQuery.find({useMasterKey: true});
  const names = roles.map(r => r.get('name'));

  writeCachedRoles(user.id!, names);
  return names;
}

/**
 * Get role names for multiple users.
 *
 * Costs one query per *role*, not one per user — which is the half that
 * matters, since the role list is a fixed property of the deployment (and
 * capped at 100 here) while the user list is whatever the caller passed. A page
 * of 500 users costs the same as a page of 5.
 *
 * It is not a single query: Parse relations cannot be filtered across roles in
 * one go. If the role count ever grows past a few dozen, this is the place to
 * look.
 */
export async function getUsersRoles(users: Parse.User[]): Promise<Map<string, string[]>> {
  if (users.length === 0) return new Map();

  // Every user already cached means the whole batch — and its one-query-per-role
  // cost — can be skipped outright.
  const fromCache = new Map<string, string[]>();
  for (const user of users) {
    const cached = readCachedRoles(user.id!);
    if (!cached) break;
    fromCache.set(user.id!, cached);
  }
  if (fromCache.size === users.length) return fromCache;

  const allRoles = await new Parse.Query('_Role').limit(100).find({useMasterKey: true});
  const userRolesMap = new Map<string, string[]>();
  for (const user of users) {
    userRolesMap.set(user.id!, []);
  }
  for (const role of allRoles) {
    const usersRelation = (role as Parse.Role).getUsers().query();
    usersRelation.containedIn('objectId', users.map(u => u.id));
    usersRelation.limit(users.length);
    const roleUsers = await usersRelation.find({useMasterKey: true});
    for (const u of roleUsers) {
      const existing = userRolesMap.get(u.id!) || [];
      existing.push(role.get('name'));
      userRolesMap.set(u.id!, existing);
    }
  }

  for (const [userId, names] of userRolesMap) writeCachedRoles(userId, names);
  return userRolesMap;
}
