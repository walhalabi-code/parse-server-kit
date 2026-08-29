---
name: parse-jobs
description: Use when adding or changing a scheduled job in this project — @Cron, CronSchedule, CronRegistry. Covers the trap where jobs never run because node-cron is not installed.
---

# Scheduled jobs

```ts
import { Cron, CronSchedule, catchError } from 'parse-server-kit';

class Jobs {
  @Cron({
    schedule: CronSchedule.DAILY_MIDNIGHT,
    description: 'Remove carts abandoned over a week ago',
    timezone: 'Europe/London',        // default 'UTC'
  })
  static async cleanupCarts() {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [err, stale] = await catchError(
      new Parse.Query('Cart')
        .lessThan('updatedAt', cutoff)
        .find({ useMasterKey: true })
    );
    if (err) throw err;

    await Parse.Object.destroyAll(stale!, { useMasterKey: true });
  }
}

export default Jobs;
```

Import the file at boot — the generated `app.ts` does this alongside the models
and functions — then `CronRegistry.initialize()` schedules everything.

## Config

| Option | |
|---|---|
| `schedule` | Cron expression. **Validated at `initialize()`**, so a bad one fails at boot |
| `description` | Free text, shown in `getJobs()` |
| `enabled` | Default `true`. `false` registers but does not schedule |
| `timezone` | Default `'UTC'` |

## `CronSchedule`

`EVERY_MINUTE`, `EVERY_5_MINUTES`, `EVERY_10_MINUTES`, `EVERY_15_MINUTES`,
`EVERY_30_MINUTES`, `EVERY_HOUR`, `EVERY_2_HOURS`, `EVERY_6_HOURS`,
`EVERY_12_HOURS`, `DAILY_MIDNIGHT`, `DAILY_NOON`, `WEEKLY_SUNDAY`,
`WEEKLY_MONDAY`, `MONTHLY_FIRST`, `YEARLY`.

A raw expression works too — `schedule: '30 3 * * 1'`.

## The trap

**`node-cron` is an optional peer dependency.** Without it,
`CronRegistry.initialize()` warns and skips, and **no job ever runs**. The
server starts normally and nothing else says anything.

```bash
npm install node-cron
```

Check the boot log:

```
[Cron] Registered: cleanupCarts (0 0 * * *)      # scheduled
[Cron] No cron jobs to register                  # nothing found
```

## MUST

- **`useMasterKey: true`** in job bodies. A job runs as the system; there is no
  `req.user` and no session, so ACLs would otherwise hide everything.
- **Catch your own errors.** An unhandled rejection in a job does not surface as
  a failed request — it goes to the process. Use `catchError` and log.
- **Make it safe to run twice.** A restart between runs, or two instances, means
  it may.

## NEVER

- Never assume it runs once across a cluster. **Every instance schedules every
  job**, so N instances means N runs. Gate on a lock row, or run jobs in a
  single dedicated instance with `enabled` off elsewhere.
- Never do a long scan on `EVERY_MINUTE`. The next tick will overlap the last.
- Never put a job's real logic inline if an endpoint also needs it — extract a
  function and call it from both.

## Controlling jobs at runtime

```ts
CronRegistry.getJobs();          // every registered job's metadata
CronRegistry.getJob(name);
CronRegistry.stopJob(name);      // unschedule, keep registered
CronRegistry.startJob(name);
CronRegistry.stopAll();          // e.g. on shutdown
await CronRegistry.runNow(name); // run the body immediately — useful in tests
```

`runNow` is the fastest way to check a job actually works without waiting for
its schedule.
