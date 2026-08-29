import {join} from 'path';
import {importFiles, implementACL, catchError} from 'parse-server-kit';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  APP_ID,
  IS_PRODUCTION,
  MASTER_KEY,
  SERVER_URL,
} from './env';
import Note from './models/Note';

/**
 * Seed data.
 *
 * Two things live here, and it is worth being clear which is which:
 *
 *   - **Reference data** your app cannot run without: the roles, and the first
 *     administrator who can sign everyone else in. This belongs in every
 *     environment, production included.
 *   - **Sample data** that exists so a fresh checkout has something to list.
 *     This belongs in development only.
 *
 * `seed()` does the first. `seedSampleData()` does the second, and `app.ts`
 * only calls it when `NODE_ENV` is not `production`.
 *
 * Everything here is **idempotent** — find first, create only if missing. Run
 * it on every deploy if you like; the second run changes nothing. That matters
 * more than it sounds: a seed you are afraid to re-run is a seed that drifts
 * out of step with the code, and you find out during an incident.
 *
 * Run it on its own with `npm run seed` (the server must be up), or let
 * `app.ts` call it at boot.
 */

/** Roles the app expects to exist. Order matters: see the hierarchy below. */
const ROLES = ['Editor', 'Admin'] as const;

/** What `seed()` actually changed, so the caller can print an honest summary. */
export interface SeedSummary {
  rolesCreated: string[];
  usersCreated: string[];
  notesCreated: number;
  /** A live session token for the demo user, when one was seeded. */
  demoSessionToken?: string;
}

/**
 * Find a role by name, or create it.
 *
 * The ACL on a role governs who may edit **the role itself** — its member list
 * — not what its members can do. Public read lets any signed-in request resolve
 * role names when evaluating permissions; write is left to the master key
 * alone, so nobody can add themselves to Admin through the API.
 */
async function findOrCreateRole(name: string): Promise<{role: Parse.Role; created: boolean}> {
  const existing = await new Parse.Query(Parse.Role)
    .equalTo('name', name)
    .first({useMasterKey: true});

  if (existing) return {role: existing as Parse.Role, created: false};

  const acl = new Parse.ACL();
  acl.setPublicReadAccess(true);
  acl.setPublicWriteAccess(false);

  const role = new Parse.Role(name, acl);
  await role.save(null, {useMasterKey: true});
  return {role, created: true};
}

/**
 * Find a user by username, or create one and put them in `roleNames`.
 *
 * The password is only used when the user does not exist yet. On a re-run this
 * function will not reset anybody's password — which is what you want, and is
 * the reason it checks first rather than calling `signUp` and catching the
 * duplicate error.
 */
async function findOrCreateUser(
  username: string,
  password: string,
  email: string,
  roleNames: string[]
): Promise<{user: Parse.User; created: boolean}> {
  const existing = await new Parse.Query(Parse.User)
    .equalTo('username', username)
    .first({useMasterKey: true});

  if (existing) return {user: existing as Parse.User, created: false};

  const user = new Parse.User();
  user.setUsername(username);
  user.setPassword(password);
  user.setEmail(email);

  // `signUp` with no attributes — they are already set above. The master key
  // is what lets this run while `allowClientClassCreation` is false and the
  // _User class has restrictive permissions.
  await user.signUp(undefined, {useMasterKey: true});

  // Role membership is a Parse relation, so adding a user is a save on the
  // ROLE, not on the user. A common early mistake is to set a `role` field on
  // the user instead; nothing in Parse reads that, and every permission check
  // then silently fails.
  for (const roleName of roleNames) {
    const {role} = await findOrCreateRole(roleName);
    role.getUsers().add(user);
    await role.save(null, {useMasterKey: true});
  }

  return {user, created: true};
}

/**
 * Make Admins count as Editors too.
 *
 * The direction is easy to get backwards. Adding role A to role B's `roles`
 * relation means *every member of A is also treated as a member of B*. So to
 * let an Admin do everything an Editor can, Admin goes inside Editor — not the
 * other way round.
 *
 * Get it backwards and nothing throws; you simply find that your Admin is
 * refused by an `Editor`-gated endpoint and there is no log to explain it.
 */
async function linkRoleHierarchy(): Promise<void> {
  const {role: editor} = await findOrCreateRole('Editor');
  const {role: admin} = await findOrCreateRole('Admin');

  // Already linked? Leave it alone, so this stays re-runnable.
  const alreadyLinked = await editor
    .getRoles()
    .query()
    .equalTo('objectId', admin.id)
    .first({useMasterKey: true});

  if (alreadyLinked) return;

  editor.getRoles().add(admin);
  await editor.save(null, {useMasterKey: true});
}

/**
 * Reference data: roles, the hierarchy between them, and the first admin.
 *
 * Safe in production. It creates nothing that is not required for the app to
 * function, and creates nothing twice.
 */
export async function seed(): Promise<SeedSummary> {
  const summary: SeedSummary = {rolesCreated: [], usersCreated: [], notesCreated: 0};

  // 1. Roles first — users cannot be assigned to a role that does not exist.
  for (const name of ROLES) {
    const {created} = await findOrCreateRole(name);
    if (created) summary.rolesCreated.push(name);
  }

  await linkRoleHierarchy();

  // 2. The first administrator.
  //
  //    The credentials come from env.ts, which is also where the fallbacks
  //    live — so `npm run seed` works on a laptop with no configuration, and
  //    the banner warns while the default password is still in use.
  const adminUsername = ADMIN_USERNAME;
  const adminPassword = ADMIN_PASSWORD;
  const adminEmail = ADMIN_EMAIL;

  const {created: adminCreated} = await findOrCreateUser(
    adminUsername,
    adminPassword,
    adminEmail,
    ['Admin']
  );
  if (adminCreated) summary.usersCreated.push(adminUsername);

  return summary;
}

/**
 * Sample data: a demo user and a few notes, so the API returns something on
 * the first request instead of an empty list.
 *
 * Development only. `app.ts` will not call this when `NODE_ENV=production`,
 * and you should delete this function once you have real data.
 */
export async function seedSampleData(summary: SeedSummary): Promise<SeedSummary> {
  const DEMO_USERNAME = 'demo';
  const DEMO_PASSWORD = 'demo-password';

  const {user: demo, created} = await findOrCreateUser(
    DEMO_USERNAME,
    DEMO_PASSWORD,
    'demo@example.com',
    ['Editor']
  );
  if (created) summary.usersCreated.push(DEMO_USERNAME);

  // Sample notes, keyed by their slug. `slug` is declared `unique: true` on the
  // model, so the query below is the same lookup the database index enforces —
  // there is no way for this to create a duplicate even under a race.
  const samples = [
    {slug: 'welcome', title: 'Welcome', body: 'Your API is running.', status: 'published'},
    {slug: 'drafts-are-private', title: 'Drafts are private', body: 'Only Editors see this.', status: 'draft'},
  ];

  for (const sample of samples) {
    const existing = await new Parse.Query(Note)
      .equalTo('slug', sample.slug)
      .first({useMasterKey: true});
    if (existing) continue;

    const note = new Note();
    note.title = sample.title;
    note.slug = sample.slug;
    note.body = sample.body;
    note.status = sample.status;

    // Row-level permissions, set once, at creation.
    //
    // `implementACL` takes a description of who may do what and RETURNS an ACL
    // — it does not take the object. Published notes are readable by anyone;
    // drafts are readable only by Editors. Either way the author keeps write
    // access, and the rule travels with the row rather than living in whatever
    // query happens to load it.
    note.setACL(
      implementACL({
        publicRead: sample.status === 'published',
        roleRules: [{role: 'Editor', read: true, write: true}],
        owner: [{user: demo, read: true, write: true}],
      })
    );

    const [err] = await catchError(note.save(null, {useMasterKey: true}));
    if (err) throw err;
    summary.notesCreated += 1;
  }

  // A session token, so the curl commands printed at boot actually work.
  //
  // `logIn` does not set a global "current user" here: the Parse SDK disables
  // that in Node unless you call `enableUnsafeCurrentUser()`. So this returns a
  // token without leaking an identity into unrelated requests.
  //
  // It is allowed to fail, and it does fail in one specific case worth knowing
  // about. Called from `app.ts` this runs in-process and goes straight to the
  // database, so it works. Run standalone (`npm run seed`) it goes over REST —
  // and `restrictRoutes` blocks Parse's built-in `/login` by design, so it comes
  // back 403. The token is a convenience, not part of seeding, so a failure
  // here must not fail the seed.
  const [loginErr, loggedIn] = await catchError(
    Parse.User.logIn(DEMO_USERNAME, DEMO_PASSWORD)
  );
  if (!loginErr && loggedIn) {
    summary.demoSessionToken = loggedIn.getSessionToken();
  }

  return summary;
}

/**
 * Standalone entry point: `npm run seed`.
 *
 * When `app.ts` calls `seed()`, Parse is already configured — parse-server put
 * the SDK on the global and pointed it at the database. Run on its own, none of
 * that has happened, so this points the SDK at the running server and talks to
 * it over REST. Going through the API rather than straight to MongoDB means the
 * seed takes the same path your app does: triggers fire, validators run, and
 * anything that would reject a real write rejects this one too.
 *
 * There is no `global.Parse` assignment here. Importing `parse-server-kit` at
 * the top of this file already loaded the SDK onto the global, so `Parse` below
 * is the very instance the models were bound to. Assigning a second one would
 * leave the models registered against the first.
 */
async function main(): Promise<void> {
  Parse.initialize(APP_ID);
  Parse.masterKey = MASTER_KEY;
  Parse.serverURL = SERVER_URL;

  // `Note` is imported at the top of this file, so it is already registered.
  // This picks up every OTHER model, so the seed keeps working as you add them.
  // `.js`, because this runs from the compiled output in build/.
  importFiles(join(__dirname, 'models'));

  const summary = await seed();
  if (!IS_PRODUCTION) {
    await seedSampleData(summary);
  }

  console.log('');
  console.log('  Seed complete.');
  console.log(`    roles created  ${summary.rolesCreated.join(', ') || 'none (already present)'}`);
  console.log(`    users created  ${summary.usersCreated.join(', ') || 'none (already present)'}`);
  console.log(`    notes created  ${summary.notesCreated}`);
  console.log('');
}

// Only when run directly — importing this file from `app.ts` must not seed as
// a side effect of the import.
if (require.main === module) {
  main().catch(error => {
    // 100 is Parse.Error.CONNECTION_FAILED. Match on the code rather than the
    // message: the SDK reports an unreachable server as `XMLHttpRequest
    // failed: "Unable to connect to the Parse API"`, which contains none of
    // the words you would think to grep for.
    const unreachable =
      error?.code === 100 ||
      /ECONNREFUSED|fetch failed|socket hang up/i.test(String(error?.message ?? error));

    if (unreachable) {
      console.error('');
      console.error('  Cannot reach the server. Seeding over REST needs it running:');
      console.error('');
      console.error('    npm run dev      (in another terminal)');
      console.error('');
      console.error(`  Tried: ${Parse.serverURL}`);
      console.error('');
      process.exit(1);
    }
    console.error(error);
    process.exit(1);
  });
}
