/**
 * Make a parent's nested image(s) FOLLOW the parent's per-record ACL, so an
 * image is visible to exactly whoever can see its parent (an active record →
 * Member/public-readable image; a hidden one → hidden image).
 *
 * `handleImageLogic` stamps a new image with the parent CLASS's static ACL
 * template, and nothing re-stamps it on later transitions — so without this,
 * catalogues render blank images and hidden parents leak readable images.
 *
 * Call `syncImageAcl(parent, [fields])` AFTER setting the parent's per-record ACL
 * and BEFORE saving the parent. It copies the parent's ACL onto each nested image
 * (single Pointer or Array-of-Pointer, e.g. `images`), dirtying it so the
 * parent's save cascades the change:
 *   - a NEW image (no id) is created with the ACL;
 *   - an EXISTING image gets an ACL-ONLY update (no file rewrite / re-process).
 *
 * The parent ACL must already carry its FINAL read grants when this is called.
 * For collections whose visibility is derived from a status in a `beforeSave`
 * trigger (e.g. `publicRead = status === 'active'`), pass that `publicRead` into
 * `implementACL` at the call site — the trigger runs AFTER this helper.
 *
 * @param acl Optional ACL source override, for callers that hold the images on a
 *            PARTIAL save object (where `parent.getACL()` isn't the live ACL).
 */
export function syncImageAcl(
  parent: Parse.Object,
  fields: string[],
  acl?: Parse.ACL
): void {
  const parentAcl = acl ?? parent.getACL();
  if (!parentAcl) return;

  for (const field of fields) {
    const value = parent.get(field);
    const images: Parse.Object[] = Array.isArray(value)
      ? (value as Parse.Object[])
      : value
        ? [value as Parse.Object]
        : [];
    for (const img of images) {
      if (img) img.setACL(cloneAcl(parentAcl));
    }
  }
}

/** Deep-copy a Parse.ACL (role, public `*`, and per-user grants). */
export function cloneAcl(acl: Parse.ACL): Parse.ACL {
  const json = acl.toJSON() as Record<
    string,
    {read?: boolean; write?: boolean}
  >;
  const clone = new Parse.ACL();
  for (const id of Object.keys(json)) {
    const perms = json[id];
    if (id === '*') {
      if (perms.read) clone.setPublicReadAccess(true);
      if (perms.write) clone.setPublicWriteAccess(true);
    } else if (id.startsWith('role:')) {
      const role = id.slice(5);
      if (perms.read) clone.setRoleReadAccess(role, true);
      if (perms.write) clone.setRoleWriteAccess(role, true);
    } else {
      if (perms.read) clone.setReadAccess(id, true);
      if (perms.write) clone.setWriteAccess(id, true);
    }
  }
  return clone;
}
