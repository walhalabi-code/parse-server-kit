import type {DashboardState} from './dashboard';
import {
  ADMIN_PASSWORD_IS_DEFAULT,
  APP_ID,
  DASHBOARD_PASS_IS_DEFAULT,
  MOUNT_PATH,
  PORT,
  SEED_ON_BOOT,
  DOCS_ENABLED,
  DOCS_PATH,
} from '../env';

/**
 * What the server prints once it is up.
 *
 * Its own file because it is presentation, and `app.ts` should read as the boot
 * sequence and nothing else. The warnings at the end are the part that matters:
 * a default password mentioned once in a README is a default password that
 * ships, so they are repeated on every boot until they are dealt with.
 */
export function printBanner(options: {
  dashboard: DashboardState;
  demoSessionToken?: string;
}): void {
  const base = `http://localhost:${PORT}`;

  console.log('');
  console.log('  Your API is running.');
  console.log('');
  console.log(`  Docs        ${DOCS_ENABLED ? `${base}${DOCS_PATH}` : 'off (DOCS_ENABLED=false)'}`);
  console.log(`  Dashboard   ${dashboardLine(options.dashboard, base)}`);
  console.log('');
  console.log('  Try it:');
  console.log('');
  console.log(`    curl "${base}${MOUNT_PATH}/notes/listNotes" \\`);
  console.log(`      -H "X-Parse-Application-Id: ${APP_ID}"`);
  console.log('');

  if (options.demoSessionToken) {
    console.log(`    curl -X POST "${base}${MOUNT_PATH}/notes/createNote" \\`);
    console.log(`      -H "X-Parse-Application-Id: ${APP_ID}" \\`);
    console.log(`      -H "X-Parse-Session-Token: ${options.demoSessionToken}" \\`);
    console.log('      -H "Content-Type: text/plain" \\');
    console.log(`      -d '{"title":"My first note"}'`);
    console.log('');
    console.log('  (user "demo" / "demo-password", in the Editor role)');
    console.log('');
  }

  printWarnings(options.dashboard);
}

function dashboardLine(state: DashboardState, base: string): string {
  if (state === 'mounted') return `${base}/dashboard`;
  if (state === 'absent') return 'npm install parse-dashboard, then restart';
  return 'not mounted: set DASHBOARD_PASS';
}

/**
 * The credentials that ship with a fresh clone.
 *
 * Fine on a laptop and not fine anywhere else, so this says so every boot
 * rather than only in the README nobody re-reads.
 */
function printWarnings(dashboard: DashboardState): void {
  if (SEED_ON_BOOT && ADMIN_PASSWORD_IS_DEFAULT) {
    console.warn('  The "admin" user has the default password "change-me-now".');
    console.warn('  Set ADMIN_PASSWORD in .env before this leaves your machine.');
    console.warn('');
  }

  // Same reasoning, different door — and this one holds the master key.
  if (dashboard === 'mounted' && DASHBOARD_PASS_IS_DEFAULT) {
    console.warn('  The dashboard is open to admin / change-me-now.');
    console.warn('  Set DASHBOARD_USER and DASHBOARD_PASS in .env.');
    console.warn('');
  }
}
