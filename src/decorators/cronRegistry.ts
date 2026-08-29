import {CronJobMetadata} from './types/cronTypes';

let cron: any;
try { cron = require('node-cron'); } catch { /* optional dependency */ }

interface ScheduledTask {
  metadata: CronJobMetadata;
  task: any;
}

export class CronRegistry {
  private static jobs: Map<string, ScheduledTask> = new Map();

  static register(metadata: CronJobMetadata): void {
    if (this.jobs.has(metadata.name)) {
      console.warn(`[Cron] Warning: Overwriting existing job '${metadata.name}'`);
    }
    this.jobs.set(metadata.name, { metadata, task: null });
  }

  static getJobs(): CronJobMetadata[] {
    return Array.from(this.jobs.values()).map(j => j.metadata);
  }

  static getJob(name: string): CronJobMetadata | undefined {
    return this.jobs.get(name)?.metadata;
  }

  static initialize(): void {
    if (!cron) {
      console.warn('[Cron] node-cron not installed — skipping cron job registration');
      return;
    }

    const jobs = this.getJobs();
    if (jobs.length === 0) {
      console.log('[Cron] No cron jobs to register');
      return;
    }

    console.log(`[Cron] Registering ${jobs.length} cron job(s)...`);

    for (const metadata of jobs) {
      const {name, schedule, handler, description, enabled = true, timezone = 'UTC'} = metadata;

      if (!enabled) { console.log(`[Cron] Skipping disabled job: ${name}`); continue; }
      if (!cron.validate(schedule)) { console.error(`[Cron] Invalid schedule for job '${name}': ${schedule}`); continue; }

      const task = cron.schedule(schedule, async () => {
        const startTime = Date.now();
        console.log(`[Cron] Running job: ${name}`);
        try {
          await handler();
          console.log(`[Cron] Job '${name}' completed in ${Date.now() - startTime}ms`);
        } catch (error: any) {
          console.error(`[Cron] Job '${name}' failed:`, error.message);
        }
      }, { timezone });

      task.start();

      const jobEntry = this.jobs.get(name);
      if (jobEntry) jobEntry.task = task;

      const desc = description ? ` - ${description}` : '';
      console.log(`[Cron] Registered: ${name} (${schedule})${desc}`);
    }

    console.log('[Cron] All cron jobs registered');
  }

  static stopJob(name: string): boolean {
    const job = this.jobs.get(name);
    if (job?.task) { job.task.stop(); return true; }
    return false;
  }

  static startJob(name: string): boolean {
    const job = this.jobs.get(name);
    if (job?.task) { job.task.start(); return true; }
    return false;
  }

  static stopAll(): void {
    for (const [, job] of this.jobs) { if (job.task) job.task.stop(); }
    console.log('[Cron] All jobs stopped');
  }

  static async runNow(name: string): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Job '${name}' not found`);
    console.log(`[Cron] Manually running job: ${name}`);
    await job.metadata.handler();
  }
}
