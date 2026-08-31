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
import {ALL_ROLES, ROLE_HIERARCHY, Roles, type Role} from './roles';

/**
 * Seed data, in two halves.
 *
 *   seed()            reference data the app cannot run without — roles and the
 *                     first admin. Safe in production.
 *   seedSampleData()  a demo user and a couple of notes, so the API returns
 *                     something on the first request. Development only; delete
 *                     it once you have real data.
 *
 * Everything is idempotent: find first, create only if missing. Re-run it on
 * every deploy — a seed you are afraid to re-run is one that drifts.
 *
 * Run with `npm run seed` (server must be up), or let `app.ts` call it at boot.
 */

export interface SeedSummary {
  rolesCreated: string[];
  usersCreated: string[];
  notesCreated: number;
  /** A live session token for the demo user, when one was seeded. */
  demoSessionToken?: string;
}

/**
 * A role's ACL governs who may edit the role itself — its member list — not
 * what its members can do. Public read so permission checks can resolve names;
 * writes left to the master key, so nobody can add themselves to Admin.
 */
async function findOrCreateRole(
  name: string
): Promise<{role: Parse.Role; created: boolean}> {
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

/** The password applies only on creation — a re-run never resets anyone's. */
async function findOrCreateUser(
  username: string,
  password: string,
  email: string,
  roleNames: Role[]
): Promise<{user: Parse.User; created: boolean}> {
  const existing = await new Parse.Query(Parse.User)
    .equalTo('username', username)
    .first({useMasterKey: true});

  if (existing) return {user: existing as Parse.User, created: false};

  const user = new Parse.User();
  user.setUsername(username);
  user.setPassword(password);
  user.setEmail(email);
  await user.signUp(undefined, {useMasterKey: true});

  // Membership is a relation on the ROLE, so this saves the role, not the user.
  // Setting a `role` field on the user instead is a common early mistake:
  // nothing in Parse reads it, and every permission check then quietly fails.
  for (const roleName of roleNames) {
    const {role} = await findOrCreateRole(roleName);
    role.getUsers().add(user);
    await role.save(null, {useMasterKey: true});
  }

  return {user, created: true};
}

/**
 * Make Admins count as Editors.
 *
 * The direction is easy to reverse: adding Admin to Editor's `roles` relation
 * means every Admin is treated as an Editor. Backwards, nothing throws — your
 * Admin is just refused by Editor-gated endpoints, with no log saying why.
 */
async function linkRoleHierarchy(): Promise<void> {
  for (const [childName, parentName] of ROLE_HIERARCHY) {
    const {role: child} = await findOrCreateRole(childName);
    const {role: parent} = await findOrCreateRole(parentName);

    const alreadyLinked = await parent
      .getRoles()
      .query()
      .equalTo('objectId', child.id)
      .first({useMasterKey: true});
    if (alreadyLinked) continue;

    parent.getRoles().add(child);
    await parent.save(null, {useMasterKey: true});
  }
}

/** Roles, the hierarchy between them, and the first admin. Safe in production. */
export async function seed(): Promise<SeedSummary> {
  const summary: SeedSummary = {rolesCreated: [], usersCreated: [], notesCreated: 0};

  // Roles first — a user cannot be assigned to a role that does not exist.
  for (const name of ALL_ROLES) {
    const {created} = await findOrCreateRole(name);
    if (created) summary.rolesCreated.push(name);
  }

  await linkRoleHierarchy();

  // Credentials come from env.ts, fallbacks included, so this works on a
  // laptop with no configuration — and the banner warns while the default
  // password is still in use.
  const {created} = await findOrCreateUser(
    ADMIN_USERNAME,
    ADMIN_PASSWORD,
    ADMIN_EMAIL,
    [Roles.ADMIN]
  );
  if (created) summary.usersCreated.push(ADMIN_USERNAME);

  return summary;
}

/** A demo user and two notes. Development only — delete once you have real data. */
export async function seedSampleData(summary: SeedSummary): Promise<SeedSummary> {
  const DEMO_USERNAME = 'demo';
  const DEMO_PASSWORD = 'demo-password';

  const {user: demo, created} = await findOrCreateUser(
    DEMO_USERNAME,
    DEMO_PASSWORD,
    'demo@example.com',
    [Roles.EDITOR]
  );
  if (created) summary.usersCreated.push(DEMO_USERNAME);

  // Keyed by slug, which is `unique: true` on the model — so this lookup is the
  // same one the database index enforces, and cannot duplicate under a race.
  const samples = [
    {slug: 'welcome', title: 'Welcome', body: 'Your API is running.', status: Note.STATUS.PUBLISHED},
    {slug: 'drafts-are-private', title: 'Drafts are private', body: 'Only Editors see this.', status: Note.STATUS.DRAFT},
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

    // implementACL takes a description of who may do what and RETURNS an ACL —
    // it does not take the object. The rule travels with the row rather than
    // living in whatever query happens to load it.
    note.setACL(
      implementACL({
        publicRead: sample.status === Note.STATUS.PUBLISHED,
        roleRules: [{role: Roles.EDITOR, read: true, write: true}],
        owner: [{user: demo, read: true, write: true}],
      })
    );

    const [err] = await catchError(note.save(null, {useMasterKey: true}));
    if (err) throw err;
    summary.notesCreated += 1;
  }

  // A token so the curl printed at boot works. Allowed to fail: run standalone
  // this goes over REST, and restrictRoutes blocks Parse's built-in /login by
  // design, so it answers 403. The token is a convenience, not part of seeding.
  const [loginErr, loggedIn] = await catchError(
    Parse.User.logIn(DEMO_USERNAME, DEMO_PASSWORD)
  );
  if (!loginErr && loggedIn) summary.demoSessionToken = loggedIn.getSessionToken();

  return summary;
}

/**
 * Standalone entry point: `npm run seed`.
 *
 * Called from app.ts, Parse is already configured. Run on its own it is not, so
 * this points the SDK at the running server and goes over REST — the same path
 * your app takes, so triggers fire and validators run.
 *
 * No `global.Parse` assignment: importing parse-server-kit above already put
 * the SDK on the global, and a second instance would leave the models
 * registered against the first.
 */
async function main(): Promise<void> {
  Parse.initialize(APP_ID);
  Parse.masterKey = MASTER_KEY;
  Parse.serverURL = SERVER_URL;

  // Note is imported above, so already registered. This picks up every other
  // model, from the compiled output in build/.
  importFiles(join(__dirname, 'models'));

  const summary = await seed();
  if (!IS_PRODUCTION) await seedSampleData(summary);

  console.log('');
  console.log('  Seed complete.');
  console.log(`    roles created  ${summary.rolesCreated.join(', ') || 'none (already present)'}`);
  console.log(`    users created  ${summary.usersCreated.join(', ') || 'none (already present)'}`);
  console.log(`    notes created  ${summary.notesCreated}`);
  console.log('');
}

// Only when run directly — importing this from app.ts must not seed.
if (require.main === module) {
  main().catch(error => {
    // 100 is Parse.Error.CONNECTION_FAILED. Match the code, not the message:
    // the SDK reports an unreachable server as `XMLHttpRequest failed`, which
    // contains none of the words you would think to grep for.
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
