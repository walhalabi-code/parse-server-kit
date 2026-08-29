type RoleRule = {role: string; read?: boolean; write?: boolean};
type OwnerRule = {user?: string | any; read?: boolean; write?: boolean};

export function implementACL(
  params: {
    publicRead?: boolean;
    publicWrite?: boolean;
    roleRules?: RoleRule[] | undefined;
    excludedRoles?: string[];
    owner?: OwnerRule[];
  },
  existingACL?: Parse.ACL
): Parse.ACL {
  const {
    publicRead = false,
    publicWrite = false,
    roleRules,
    excludedRoles = [],
    owner = [],
  } = params;

  const acl = existingACL ?? new Parse.ACL();

  acl.setPublicReadAccess(!!publicRead);
  acl.setPublicWriteAccess(!!publicWrite);

  for (const {role, read = false, write = false} of roleRules ?? []) {
    if (excludedRoles.includes(role)) continue;
    if (read) acl.setRoleReadAccess(role, true);
    else acl.setRoleReadAccess(role, false);
    if (write) acl.setRoleWriteAccess(role, true);
    else acl.setRoleWriteAccess(role, false);
  }

  for (const {user, read = false, write = false} of owner) {
    if (user !== undefined) {
      if (read) acl.setReadAccess(user, true);
      else acl.setReadAccess(user, false);
      if (write) acl.setWriteAccess(user, true);
      else acl.setWriteAccess(user, false);
    }
  }

  return acl;
}
