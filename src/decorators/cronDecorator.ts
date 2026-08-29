import 'reflect-metadata';
import {CronConfig} from './types/cronTypes';
import {CronRegistry} from './cronRegistry';

export function Cron(config: CronConfig) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const handler = descriptor.value;
    if (typeof handler !== 'function') {
      throw new Error(`@Cron decorator can only be applied to methods.`);
    }

    CronRegistry.register({
      name: propertyKey,
      schedule: config.schedule,
      handler: handler,
      description: config.description,
      enabled: config.enabled ?? true,
      timezone: config.timezone ?? 'UTC',
    });

    return descriptor;
  };
}

export {CronSchedule} from './types/cronTypes';
export {CronRegistry} from './cronRegistry';
