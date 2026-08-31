import type express from 'express';
import {
  APP_ID,
  DASHBOARD_PASS,
  DASHBOARD_USER,
  IS_PRODUCTION,
  MASTER_KEY,
  SERVER_URL,
} from '../env';

/** What happened when we tried to mount it, so the banner can tell the truth. */
export type DashboardState = 'mounted' | 'absent' | 'unsafe';

/**
 * Mount Parse Dashboard at `/dashboard`, if it is installed.
 *
 * It is **not** a dependency of this project. The dashboard is a bundled React
 * app and pulls in a lot for something plenty of services never expose, so it
 * is opt-in:
 *
 *     npm install parse-dashboard
 *
 * Restart and it appears. Nothing else to wire — the same treatment this
 * library gives `node-cron` and `swagger-ui-express`.
 */
export function mountDashboard(app: express.Express): DashboardState {
  let ParseDashboard: new (config: unknown, options: unknown) => express.RequestHandler;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ParseDashboard = require('parse-dashboard');
  } catch {
    return 'absent';
  }

  // The dashboard holds the master key. Unauthenticated, it is a full read and
  // write console for your entire database, reachable by anyone who finds the
  // URL — so credentials are not optional. In production `DASHBOARD_PASS` has
  // no fallback, which is what makes this refuse rather than expose.
  if (!DASHBOARD_PASS) return 'unsafe';

  const dashboard = new ParseDashboard(
    {
      apps: [
        {
          serverURL: SERVER_URL,
          appId: APP_ID,
          masterKey: MASTER_KEY,
          appName: '{{PROJECT_NAME}}',
        },
      ],
      users: [{user: DASHBOARD_USER, pass: DASHBOARD_PASS}],
    },
    {
      // It refuses to serve over plain HTTP unless told to, which is the right
      // default — the master key would be in flight. Allowed here only because
      // localhost development is not production.
      allowInsecureHTTP: !IS_PRODUCTION,
    }
  );

  // Mounted outside MOUNT_PATH, so restrictRoutes never sees it. That is not a
  // loophole: the dashboard reaches the API with the master key, which bypasses
  // those restrictions anyway.
  app.use('/dashboard', dashboard);
  return 'mounted';
}
