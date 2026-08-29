import 'reflect-metadata';
import {implementACL} from '../src/utils/ACL';
import {syncImageAcl, cloneAcl} from '../src/utils/imageAcl';

/**
 * `implementACL` is this library's headline feature and, until now, the only
 * substantial file with no tests at all — it did not even appear in the coverage
 * table, because nothing imported it.
 *
 * These tests run against the real Parse SDK (see test/setup.ts), so the ACL
 * objects here are the genuine article and `toJSON()` is exactly what would be
 * written to the database.
 *
 * Several of them pin behaviour that is surprising rather than wrong. Those are
 * marked, because a test is the only place that kind of thing stays true.
 */

/** The wire format: what actually lands in the row's ACL column. */
const json = (acl: Parse.ACL) => acl.toJSON() as Record<string, {read?: boolean; write?: boolean}>;

describe('implementACL', () => {
  describe('the shape of the API', () => {
    it('returns an ACL rather than taking the object', () => {
      // The single most common mistake is implementACL(obj, {...}), which is
      // not a signature this function has. It takes a description and hands
      // back an ACL for the caller to assign with setACL.
      const acl = implementACL({publicRead: true});
      expect(acl).toBeInstanceOf(Parse.ACL);
    });

    it('grants nothing at all when given an empty description', () => {
      // No keys means no grants: master key only. Not "public by default".
      expect(json(implementACL({}))).toEqual({});
    });
  });

  describe('public access', () => {
    it('grants public read', () => {
      expect(json(implementACL({publicRead: true}))).toEqual({'*': {read: true}});
    });

    it('grants public write', () => {
      expect(json(implementACL({publicWrite: true}))).toEqual({'*': {write: true}});
    });

    it('grants both', () => {
      const acl = implementACL({publicRead: true, publicWrite: true});
      expect(json(acl)).toEqual({'*': {read: true, write: true}});
    });

    it('defaults both to false', () => {
      expect(json(implementACL({roleRules: [{role: 'Admin', read: true}]}))).toEqual({
        'role:Admin': {read: true},
      });
    });

    it('accepts a truthy non-boolean, since callers pass expressions', () => {
      // publicRead: status === 'published' is the documented pattern, but
      // callers also pass things like a non-empty string.
      const acl = implementACL({publicRead: 'yes' as unknown as boolean});
      expect(json(acl)).toEqual({'*': {read: true}});
    });
  });

  describe('role rules', () => {
    it('grants read and write to a role', () => {
      const acl = implementACL({roleRules: [{role: 'Admin', read: true, write: true}]});
      expect(json(acl)).toEqual({'role:Admin': {read: true, write: true}});
    });

    it('grants read only', () => {
      const acl = implementACL({roleRules: [{role: 'Viewer', read: true}]});
      expect(json(acl)).toEqual({'role:Viewer': {read: true}});
    });

    it('handles several roles at once', () => {
      const acl = implementACL({
        roleRules: [
          {role: 'Admin', read: true, write: true},
          {role: 'Editor', read: true},
        ],
      });
      expect(json(acl)).toEqual({
        'role:Admin': {read: true, write: true},
        'role:Editor': {read: true},
      });
    });

    it('lets a later rule override an earlier one for the same role', () => {
      const acl = implementACL({
        roleRules: [
          {role: 'Admin', read: true, write: true},
          {role: 'Admin', read: true},
        ],
      });
      // Last one wins: write is revoked by the second rule.
      expect(json(acl)).toEqual({'role:Admin': {read: true}});
    });

    it('treats an undefined roleRules the same as none', () => {
      expect(json(implementACL({roleRules: undefined, publicRead: true}))).toEqual({
        '*': {read: true},
      });
    });
  });

  describe('owner rules', () => {
    it('grants access to a user id', () => {
      const acl = implementACL({owner: [{user: 'abc123', read: true, write: true}]});
      expect(json(acl)).toEqual({abc123: {read: true, write: true}});
    });

    it('accepts a Parse.User object, not only an id', () => {
      const user = new Parse.User();
      user.id = 'user789';
      const acl = implementACL({owner: [{user, read: true}]});
      expect(json(acl)).toEqual({user789: {read: true}});
    });

    it('grants read without write, for a record its owner may see but not edit', () => {
      // The orders tutorial's "readable once paid, editable only while pending".
      const acl = implementACL({owner: [{user: 'abc123', read: true, write: false}]});
      expect(json(acl)).toEqual({abc123: {read: true}});
    });

    it('skips an entry whose user is undefined', () => {
      // A missing req.user must not throw, and must not grant anything.
      const acl = implementACL({
        owner: [{user: undefined, read: true, write: true}],
        publicRead: true,
      });
      expect(json(acl)).toEqual({'*': {read: true}});
    });

    it('handles several owners', () => {
      const acl = implementACL({
        owner: [
          {user: 'author', read: true, write: true},
          {user: 'reviewer', read: true},
        ],
      });
      expect(json(acl)).toEqual({
        author: {read: true, write: true},
        reviewer: {read: true},
      });
    });
  });

  describe('excludedRoles', () => {
    it('leaves an excluded role out of a fresh ACL', () => {
      const acl = implementACL({
        roleRules: [
          {role: 'Admin', read: true, write: true},
          {role: 'Banned', read: true, write: true},
        ],
        excludedRoles: ['Banned'],
      });
      expect(json(acl)).toEqual({'role:Admin': {read: true, write: true}});
    });

    it('excludes several roles', () => {
      const acl = implementACL({
        roleRules: [
          {role: 'A', read: true},
          {role: 'B', read: true},
          {role: 'C', read: true},
        ],
        excludedRoles: ['A', 'C'],
      });
      expect(json(acl)).toEqual({'role:B': {read: true}});
    });

    it('SKIPS the rule rather than denying the role', () => {
      // Worth being precise about, because the name suggests otherwise.
      // `excludedRoles` means "do not process this rule", so an existing grant
      // for that role SURVIVES. To take access away, pass the rule with
      // read/write false instead of excluding it.
      const existing = new Parse.ACL();
      existing.setRoleReadAccess('Legacy', true);
      existing.setRoleWriteAccess('Legacy', true);

      const acl = implementACL(
        {roleRules: [{role: 'Legacy', read: false, write: false}], excludedRoles: ['Legacy']},
        existing
      );

      expect(json(acl)).toEqual({'role:Legacy': {read: true, write: true}});
    });
  });

  describe('an existing ACL', () => {
    it('adds to it and returns it', () => {
      const existing = new Parse.ACL();
      existing.setRoleReadAccess('Admin', true);

      const acl = implementACL({owner: [{user: 'abc123', read: true}]}, existing);

      expect(json(acl)).toEqual({
        'role:Admin': {read: true},
        abc123: {read: true},
      });
    });

    it('MUTATES the ACL passed in rather than copying it', () => {
      // The returned value and the argument are the same object. Pass
      // cloneAcl(existing) if the original must stay untouched.
      const existing = new Parse.ACL();
      const acl = implementACL({publicRead: true}, existing);

      expect(acl).toBe(existing);
      expect(json(existing)).toEqual({'*': {read: true}});
    });

    it('REVOKES public read when publicRead is not restated', () => {
      // The trap. Public access is written unconditionally on every call, so
      // re-running implementACL over an existing ACL without repeating
      // publicRead silently takes it away. In a beforeSave trigger that runs on
      // every save, the rule has to be restated each time — which is exactly
      // what `publicRead: status === 'published'` does.
      const existing = new Parse.ACL();
      existing.setPublicReadAccess(true);
      existing.setRoleReadAccess('Admin', true);

      const acl = implementACL({roleRules: [{role: 'Admin', read: true}]}, existing);

      expect(json(acl)).toEqual({'role:Admin': {read: true}});
      expect(acl.getPublicReadAccess()).toBe(false);
    });

    it('revokes a role grant when the rule says false', () => {
      const existing = new Parse.ACL();
      existing.setRoleReadAccess('Editor', true);
      existing.setRoleWriteAccess('Editor', true);

      const acl = implementACL(
        {roleRules: [{role: 'Editor', read: true, write: false}]},
        existing
      );

      expect(json(acl)).toEqual({'role:Editor': {read: true}});
    });

    it('revokes an owner grant when the rule says false', () => {
      const existing = new Parse.ACL();
      existing.setReadAccess('abc123', true);
      existing.setWriteAccess('abc123', true);

      const acl = implementACL({owner: [{user: 'abc123', read: true}]}, existing);

      expect(json(acl)).toEqual({abc123: {read: true}});
    });

    it('revokes a role READ grant, leaving write in place', () => {
      // The awkward combination — write without read — is expressible, and a
      // rule that omits `read` takes an existing read away.
      const existing = new Parse.ACL();
      existing.setRoleReadAccess('Bot', true);
      existing.setRoleWriteAccess('Bot', true);

      const acl = implementACL({roleRules: [{role: 'Bot', write: true}]}, existing);

      expect(json(acl)).toEqual({'role:Bot': {write: true}});
    });

    it('revokes an owner READ grant, leaving write in place', () => {
      const existing = new Parse.ACL();
      existing.setReadAccess('abc123', true);
      existing.setWriteAccess('abc123', true);

      const acl = implementACL({owner: [{user: 'abc123', write: true}]}, existing);

      expect(json(acl)).toEqual({abc123: {write: true}});
    });

    it('strips every grant when a rule names the role with nothing allowed', () => {
      // This, not excludedRoles, is how you actually take a role's access away.
      const existing = new Parse.ACL();
      existing.setRoleReadAccess('Legacy', true);
      existing.setRoleWriteAccess('Legacy', true);

      const acl = implementACL({roleRules: [{role: 'Legacy'}]}, existing);

      expect(json(acl)).toEqual({});
    });
  });

  describe('the documented patterns', () => {
    it('private to its owner, visible to staff', () => {
      const acl = implementACL({
        roleRules: [{role: 'Admin', read: true, write: true}],
        owner: [{user: 'author1', read: true, write: true}],
      });
      expect(json(acl)).toEqual({
        'role:Admin': {read: true, write: true},
        author1: {read: true, write: true},
      });
      expect(acl.getPublicReadAccess()).toBe(false);
    });

    it('public once published, staff-only while a draft', () => {
      const forStatus = (status: string) =>
        json(
          implementACL({
            publicRead: status === 'published',
            roleRules: [{role: 'Editor', read: true, write: true}],
            owner: [{user: 'author1', read: true, write: true}],
          })
        );

      expect(forStatus('published')).toEqual({
        '*': {read: true},
        'role:Editor': {read: true, write: true},
        author1: {read: true, write: true},
      });

      expect(forStatus('draft')).toEqual({
        'role:Editor': {read: true, write: true},
        author1: {read: true, write: true},
      });
    });

    it('read-only to its owner once locked', () => {
      const acl = implementACL({
        roleRules: [{role: 'Admin', read: true, write: true}],
        owner: [{user: 'customer1', read: true, write: false}],
      });
      expect(json(acl)).toEqual({
        'role:Admin': {read: true, write: true},
        customer1: {read: true},
      });
    });
  });
});

describe('cloneAcl', () => {
  it('copies public, role and user grants', () => {
    const original = new Parse.ACL();
    original.setPublicReadAccess(true);
    original.setRoleReadAccess('Admin', true);
    original.setRoleWriteAccess('Admin', true);
    original.setReadAccess('user1', true);

    expect(json(cloneAcl(original))).toEqual(json(original));
  });

  it('is a real copy — changing the clone leaves the original alone', () => {
    const original = new Parse.ACL();
    original.setPublicReadAccess(true);

    const copy = cloneAcl(original);
    copy.setPublicReadAccess(false);
    copy.setRoleWriteAccess('Admin', true);

    expect(original.getPublicReadAccess()).toBe(true);
    expect(json(original)).toEqual({'*': {read: true}});
  });

  it('copies an empty ACL as an empty ACL', () => {
    expect(json(cloneAcl(new Parse.ACL()))).toEqual({});
  });

  it('keeps write-only grants', () => {
    const original = new Parse.ACL();
    original.setPublicWriteAccess(true);
    original.setRoleWriteAccess('Bot', true);
    original.setWriteAccess('user1', true);

    expect(json(cloneAcl(original))).toEqual({
      '*': {write: true},
      'role:Bot': {write: true},
      user1: {write: true},
    });
  });
});

describe('syncImageAcl', () => {
  /** A parent with a final ACL already set, as the docs require. */
  function parentWithAcl(): Parse.Object {
    const parent = new Parse.Object('Article');
    const acl = new Parse.ACL();
    acl.setPublicReadAccess(true);
    acl.setRoleWriteAccess('Editor', true);
    parent.setACL(acl);
    return parent;
  }

  it('copies the parent ACL onto a single pointer field', () => {
    const parent = parentWithAcl();
    const cover = new Parse.Object('IMG');
    parent.set('cover', cover);

    syncImageAcl(parent, ['cover']);

    expect(json(cover.getACL()!)).toEqual(json(parent.getACL()!));
  });

  it('copies onto every image in an array field', () => {
    const parent = parentWithAcl();
    const images = [new Parse.Object('IMG'), new Parse.Object('IMG')];
    parent.set('images', images);

    syncImageAcl(parent, ['images']);

    for (const img of images) {
      expect(json(img.getACL()!)).toEqual(json(parent.getACL()!));
    }
  });

  it('gives each image its own ACL instance, not one shared object', () => {
    // Sharing would mean editing one image's permissions silently edited every
    // other image's, and the parent's.
    const parent = parentWithAcl();
    const [a, b] = [new Parse.Object('IMG'), new Parse.Object('IMG')];
    parent.set('images', [a, b]);

    syncImageAcl(parent, ['images']);
    a.getACL()!.setPublicReadAccess(false);

    expect(b.getACL()!.getPublicReadAccess()).toBe(true);
    expect(parent.getACL()!.getPublicReadAccess()).toBe(true);
  });

  it('handles several fields in one call', () => {
    const parent = parentWithAcl();
    const cover = new Parse.Object('IMG');
    const gallery = [new Parse.Object('IMG')];
    parent.set('cover', cover);
    parent.set('gallery', gallery);

    syncImageAcl(parent, ['cover', 'gallery']);

    expect(json(cover.getACL()!)).toEqual(json(parent.getACL()!));
    expect(json(gallery[0].getACL()!)).toEqual(json(parent.getACL()!));
  });

  it('does nothing when the parent has no ACL', () => {
    // Nothing to copy. Stamping an empty ACL would lock the image to the
    // master key, which is worse than leaving it as it was.
    const parent = new Parse.Object('Article');
    const cover = new Parse.Object('IMG');
    parent.set('cover', cover);

    syncImageAcl(parent, ['cover']);

    // Parse reports "no ACL" as null, not undefined.
    expect(cover.getACL()).toBeNull();
  });

  it('ignores a field that is not set', () => {
    const parent = parentWithAcl();
    expect(() => syncImageAcl(parent, ['missing'])).not.toThrow();
  });

  it('ignores a field explicitly set to null', () => {
    const parent = parentWithAcl();
    parent.set('cover', null);
    expect(() => syncImageAcl(parent, ['cover'])).not.toThrow();
  });

  it('ignores an empty array', () => {
    const parent = parentWithAcl();
    parent.set('images', []);
    expect(() => syncImageAcl(parent, ['images'])).not.toThrow();
  });

  it('skips null entries inside an array', () => {
    const parent = parentWithAcl();
    const real = new Parse.Object('IMG');
    parent.set('images', [null, real, undefined]);

    expect(() => syncImageAcl(parent, ['images'])).not.toThrow();
    expect(json(real.getACL()!)).toEqual(json(parent.getACL()!));
  });

  it('uses the acl override when the parent is a partial save object', () => {
    // The documented escape hatch: the caller holds the images on an object
    // whose getACL() is not the live ACL.
    const parent = new Parse.Object('Article');
    const cover = new Parse.Object('IMG');
    parent.set('cover', cover);

    const live = new Parse.ACL();
    live.setRoleReadAccess('Member', true);

    syncImageAcl(parent, ['cover'], live);

    expect(json(cover.getACL()!)).toEqual({'role:Member': {read: true}});
  });

  it('prefers the override over the parent ACL when both exist', () => {
    const parent = parentWithAcl();
    const cover = new Parse.Object('IMG');
    parent.set('cover', cover);

    const override = new Parse.ACL();
    override.setRoleReadAccess('Member', true);

    syncImageAcl(parent, ['cover'], override);

    expect(json(cover.getACL()!)).toEqual({'role:Member': {read: true}});
  });

  it('replaces an image ACL rather than merging into it', () => {
    // An image stamped with the class template must end up matching its
    // parent exactly, not accumulating both sets of grants.
    const parent = parentWithAcl();
    const cover = new Parse.Object('IMG');
    const stale = new Parse.ACL();
    stale.setRoleReadAccess('OldRole', true);
    cover.setACL(stale);
    parent.set('cover', cover);

    syncImageAcl(parent, ['cover']);

    expect(json(cover.getACL()!)).toEqual(json(parent.getACL()!));
    expect(json(cover.getACL()!)['role:OldRole']).toBeUndefined();
  });

  it('carries a hidden parent through to its images', () => {
    // The failure this helper exists to prevent: a hidden parent whose images
    // stayed publicly readable.
    const parent = new Parse.Object('Article');
    const hidden = new Parse.ACL();
    hidden.setRoleReadAccess('Editor', true);
    parent.setACL(hidden);

    const cover = new Parse.Object('IMG');
    const wasPublic = new Parse.ACL();
    wasPublic.setPublicReadAccess(true);
    cover.setACL(wasPublic);
    parent.set('cover', cover);

    syncImageAcl(parent, ['cover']);

    expect(cover.getACL()!.getPublicReadAccess()).toBe(false);
    expect(json(cover.getACL()!)).toEqual({'role:Editor': {read: true}});
  });
});
