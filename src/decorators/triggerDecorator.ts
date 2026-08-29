import 'reflect-metadata';
import {TriggerConfig, TriggerType} from './types/triggerTypes';

/**
 * Classes that have parked a trigger but not yet had it flushed.
 *
 * A trigger decorator cannot register anything on its own — it does not know
 * the Parse class name, which only `@ParseClass` supplies. So it parks the
 * handler in metadata and waits. On a class that never gets `@ParseClass`, it
 * waits forever: the trigger is simply never registered, and nothing says so.
 *
 * Recording the constructor here lets `TriggerRegistry.initialize()` name the
 * classes still waiting. Exported for that purpose only.
 */
export const pendingTriggerOwners = new Map<Function, string[]>();

/** Called by `@ParseClass` once it has flushed a class's pending triggers. */
export function markTriggersFlushed(constructor: Function): void {
  pendingTriggerOwners.delete(constructor);
}

function createTriggerDecorator(type: TriggerType) {
  return function (config: TriggerConfig = {}) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
      const handler = descriptor.value;
      if (typeof handler !== 'function') {
        throw new Error(`@${type} decorator can only be applied to methods.`);
      }

      const constructor = typeof target === 'function' ? target : target.constructor;

      /*
       * Clone-on-first-write — the same trap as `parse:fields`.
       *
       * `getMetadata` walks the prototype chain, so a subclass with no
       * triggers of its own is handed the PARENT's array. Pushing into it
       * registers this subclass's trigger against the parent and every
       * sibling, so a `beforeSave` written for Order also fires for Product.
       *
       * `getOwnMetadata` asks only this class; absent, copy what was inherited
       * so a subclass still carries its parent's triggers.
       */
      const ownTriggers = Reflect.getOwnMetadata('parse:pendingTriggers', constructor);
      const pendingTriggers: any[] =
        ownTriggers ?? [...(Reflect.getMetadata('parse:pendingTriggers', constructor) || [])];

      pendingTriggers.push({
        type,
        handler,
        description: config.description,
        validation: config.validation,
      });
      Reflect.defineMetadata('parse:pendingTriggers', pendingTriggers, constructor);

      const waiting = pendingTriggerOwners.get(constructor) ?? [];
      waiting.push(type);
      pendingTriggerOwners.set(constructor, waiting);

      return descriptor;
    };
  };
}

// Object triggers
export const BeforeSave = createTriggerDecorator('beforeSave');
export const AfterSave = createTriggerDecorator('afterSave');
export const BeforeDelete = createTriggerDecorator('beforeDelete');
export const AfterDelete = createTriggerDecorator('afterDelete');
export const BeforeFind = createTriggerDecorator('beforeFind');
export const AfterFind = createTriggerDecorator('afterFind');

// User auth triggers
export const BeforeLogin = createTriggerDecorator('beforeLogin');
export const AfterLogin = createTriggerDecorator('afterLogin');
export const AfterLogout = createTriggerDecorator('afterLogout');
/** parse-server 8.5+. Runs before a password reset email is sent. */
export const BeforePasswordResetRequest = createTriggerDecorator('beforePasswordResetRequest');

// File triggers
export const BeforeSaveFile = createTriggerDecorator('beforeSaveFile');
export const AfterSaveFile = createTriggerDecorator('afterSaveFile');
export const BeforeDeleteFile = createTriggerDecorator('beforeDeleteFile');
export const AfterDeleteFile = createTriggerDecorator('afterDeleteFile');
/** parse-server 8.1+. */
export const BeforeFindFile = createTriggerDecorator('beforeFindFile');
/** parse-server 8.1+. */
export const AfterFindFile = createTriggerDecorator('afterFindFile');

// Parse Config triggers (parse-server 7.3+)
export const BeforeSaveConfig = createTriggerDecorator('beforeSaveConfig');
export const AfterSaveConfig = createTriggerDecorator('afterSaveConfig');

// LiveQuery triggers
export const BeforeConnect = createTriggerDecorator('beforeConnect');
export const BeforeSubscribe = createTriggerDecorator('beforeSubscribe');
export const AfterEvent = createTriggerDecorator('afterEvent');
