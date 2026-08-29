import {TriggerMetadata, TriggerType} from './types/triggerTypes';
import {pendingTriggerOwners} from './triggerDecorator';

/**
 * Triggers on Parse's own built-in entities.
 *
 * These are not registered by class *name* — parse-server wants the class
 * itself, and maps it internally to a reserved name (`@File`, `@Config`). It
 * used to expose a dedicated method per file trigger (`beforeSaveFile` and
 * friends); those were removed, and calling them on parse-server 9 throws
 * `TypeError: not a function`. The class-argument form is the supported one.
 *
 * Resolved lazily, inside `initialize()`: `Parse` is a global supplied by
 * parse-server, and reading it at module load would break importing the kit
 * before the server is up.
 */
function builtInTarget(type: TriggerType): unknown | undefined {
  const P = Parse as unknown as {File?: unknown; Config?: unknown};
  if (type.endsWith('File')) return P.File;
  if (type.endsWith('Config')) return P.Config;
  return undefined;
}

export class TriggerRegistry {
  private static triggers: Map<string, TriggerMetadata> = new Map();

  private static getKey(className: string, type: TriggerType): string {
    return `${className}:${type}`;
  }

  static register(metadata: TriggerMetadata): void {
    const key = this.getKey(metadata.className, metadata.type);
    if (this.triggers.has(key)) {
      console.warn(`[Triggers] Warning: Overwriting existing ${metadata.type} trigger for ${metadata.className}`);
    }
    this.triggers.set(key, metadata);
  }

  static getTriggers(): TriggerMetadata[] {
    return Array.from(this.triggers.values());
  }

  static getTriggersForClass(className: string): TriggerMetadata[] {
    return this.getTriggers().filter(t => t.className === className);
  }

  /**
   * Name any class that declared a trigger but never got `@ParseClass`.
   *
   * Those triggers are parked in metadata waiting for a class name that never
   * arrives, so they are never registered and never fire. Previously the only
   * evidence was that the trigger did not run.
   */
  private static reportUnflushed(): void {
    if (pendingTriggerOwners.size === 0) return;

    for (const [constructor, types] of pendingTriggerOwners) {
      console.warn(
        `[Triggers] ${constructor.name || 'A class'} declares ` +
          `${types.join(', ')} but has no @ParseClass, so ${
            types.length > 1 ? 'they are' : 'it is'
          } NOT registered and will never fire. ` +
          'Trigger decorators need @ParseClass to tell them which Parse class they belong to.'
      );
    }
  }

  static initialize(): void {
    this.reportUnflushed();

    const triggers = this.getTriggers();
    if (triggers.length === 0) {
      console.log('[Triggers] No triggers to register');
      return;
    }

    console.log(`[Triggers] Registering ${triggers.length} trigger(s)...`);

    for (const metadata of triggers) {
      const {type, className, handler, validation} = metadata;
      const Cloud = Parse.Cloud as any;

      // For a built-in entity the "class" is Parse.File / Parse.Config itself;
      // for everything else it is the registered class name.
      const target = builtInTarget(type) ?? className;
      const label = target === className ? className : type.replace(/^(before|after)/, '');

      switch (type) {
        case 'beforeSave': Parse.Cloud.beforeSave(className, handler as any, validation); break;
        case 'afterSave': Parse.Cloud.afterSave(className, handler as any, validation); break;
        case 'beforeDelete': Parse.Cloud.beforeDelete(className, handler as any, validation); break;
        case 'afterDelete': Parse.Cloud.afterDelete(className, handler as any, validation); break;
        case 'beforeFind': Parse.Cloud.beforeFind(className, handler as any, validation); break;
        case 'afterFind': Parse.Cloud.afterFind(className, handler as any, validation); break;
        case 'beforeLogin': Parse.Cloud.beforeLogin(handler as any); break;
        case 'afterLogin': Parse.Cloud.afterLogin(handler as any, validation); break;
        case 'afterLogout': Parse.Cloud.afterLogout(handler as any, validation); break;
        case 'beforePasswordResetRequest': Cloud.beforePasswordResetRequest(handler, validation); break;

        // File triggers — the class-argument form. The old dedicated methods
        // (`beforeSaveFile` etc.) no longer exist on parse-server 9.
        case 'beforeSaveFile': Cloud.beforeSave(target, handler, validation); break;
        case 'afterSaveFile': Cloud.afterSave(target, handler, validation); break;
        case 'beforeDeleteFile': Cloud.beforeDelete(target, handler, validation); break;
        case 'afterDeleteFile': Cloud.afterDelete(target, handler, validation); break;
        case 'beforeFindFile': Cloud.beforeFind(target, handler, validation); break;
        case 'afterFindFile': Cloud.afterFind(target, handler, validation); break;

        // Parse Config triggers — same class-argument form.
        case 'beforeSaveConfig': Cloud.beforeSave(target, handler, validation); break;
        case 'afterSaveConfig': Cloud.afterSave(target, handler, validation); break;

        case 'beforeConnect': Cloud.beforeConnect(handler, validation); break;
        case 'beforeSubscribe': Cloud.beforeSubscribe(className, handler, validation); break;
        case 'afterEvent': Cloud.afterLiveQueryEvent(className, handler, validation); break;
      }

      console.log(`[Triggers] Registered ${type} for: ${label}`);
    }

    console.log('[Triggers] All triggers registered');
  }
}
