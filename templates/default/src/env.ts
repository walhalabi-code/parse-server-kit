import 'dotenv/config';

/**
 * Every setting this project reads, in one place.
 *
 * Here rather than in `app.ts` because three files need them: the server, the
 * standalone seed, and the dashboard mount. Duplicating `process.env.APP_ID ||
 * '...'` in each is how a fallback drifts and one of them quietly talks to the
 * wrong database.
 *
 * `dotenv/config` is imported here, so importing this module is enough to have
 * `.env` loaded — no file needs to remember to do it first.
 */

export const APP_ID = process.env.APP_ID || '{{APP_ID}}';
export const MASTER_KEY = process.env.MASTER_KEY || '{{MASTER_KEY}}';
export const MAINTENANCE_KEY =
  process.env.MAINTENANCE_KEY || '{{MAINTENANCE_KEY}}';

export const MOUNT_PATH = process.env.MOUNT_PATH || '/api';
export const PORT = Number(process.env.PORT) || 1337;

export const DATABASE_URI =
  process.env.DATABASE_URI || 'mongodb://localhost:27017/{{PROJECT_NAME}}';

/** Must be the URL clients actually reach, or file links point nowhere. */
export const SERVER_URL =
  process.env.SERVER_URL || `http://localhost:${PORT}${MOUNT_PATH}`;

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Seeding at boot is convenient in development and a liability in production,
 * where a deploy pipeline should run `npm run seed` as its own step and fail
 * loudly if it fails. On outside production; `SEED_ON_BOOT` overrides either
 * way.
 */
export const SEED_ON_BOOT = process.env.SEED_ON_BOOT
  ? process.env.SEED_ON_BOOT === 'true'
  : !IS_PRODUCTION;

/** The first administrator the seed creates. */
export const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';

/** Whether the admin password is still the published default. */
export const ADMIN_PASSWORD_IS_DEFAULT = !process.env.ADMIN_PASSWORD;

/** Credentials for the Parse Dashboard, if it is installed. */
export const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
export const DASHBOARD_PASS =
  process.env.DASHBOARD_PASS || (IS_PRODUCTION ? '' : 'change-me-now');
export const DASHBOARD_PASS_IS_DEFAULT = !process.env.DASHBOARD_PASS;
