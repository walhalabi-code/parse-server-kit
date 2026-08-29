export interface CronJobMetadata {
  name: string;
  schedule: string;
  handler: () => Promise<void> | void;
  description?: string;
  enabled?: boolean;
  timezone?: string;
}

export interface CronConfig {
  schedule: string;
  description?: string;
  enabled?: boolean;
  timezone?: string;
}

export const CronSchedule = {
  EVERY_MINUTE: '* * * * *',
  EVERY_5_MINUTES: '*/5 * * * *',
  EVERY_10_MINUTES: '*/10 * * * *',
  EVERY_15_MINUTES: '*/15 * * * *',
  EVERY_30_MINUTES: '*/30 * * * *',
  EVERY_HOUR: '0 * * * *',
  EVERY_2_HOURS: '0 */2 * * *',
  EVERY_6_HOURS: '0 */6 * * *',
  EVERY_12_HOURS: '0 */12 * * *',
  DAILY_MIDNIGHT: '0 0 * * *',
  DAILY_NOON: '0 12 * * *',
  WEEKLY_SUNDAY: '0 0 * * 0',
  WEEKLY_MONDAY: '0 0 * * 1',
  MONTHLY_FIRST: '0 0 1 * *',
  YEARLY: '0 0 1 1 *',
} as const;
