import {CloudFunctionMetadata} from './types/cloudTypes';
import {RouteRegistry} from './routeDecorator';
import {VersionRegistry} from '../database/versionRegistry';

export class CloudFunctionRegistry {
  private static functions: Map<string, CloudFunctionMetadata> = new Map();

  static register(metadata: CloudFunctionMetadata) {
    this.functions.set(metadata.name, metadata);
  }

  static getFunctions() {
    return Array.from(this.functions.values());
  }

  static getFunction(name: string) {
    return this.functions.get(name);
  }

  /**
   * The method as it stands now, not as it stood when the decorator ran.
   *
   * `@CloudFunction` sees `descriptor.value` at the moment it is applied, and
   * decorators apply bottom-up — so anything written *above* it, such as
   * `@Transactional()`, has not wrapped the method yet. Registering that early
   * snapshot meant the outer decorator was silently dropped: the endpoint
   * worked, every write succeeded, and nothing was ever atomic.
   *
   * Reading the property back at registration time picks up every wrapper,
   * whichever order they were written in.
   */
  private static resolveHandler(metadata: CloudFunctionMetadata) {
    const {owner, propertyKey} = metadata;
    if (owner && propertyKey) {
      const current = owner[propertyKey];
      if (typeof current === 'function') return current;
    }
    return metadata.handler;
  }

  static initialize() {
    this.functions.forEach(metadata => {
      const handler = this.resolveHandler(metadata);
      Parse.Cloud.define(metadata.name, handler, metadata.config.validation);
      console.log(`Registered cloud function: ${metadata.name}`);
    });

    // Build entity-based route map after all functions are registered
    RouteRegistry.initialize();

    // Last point at boot where both the models and the database adapter are
    // known, so it is the only place that can tell whether a declared
    // @ParseVersionField actually has anything enforcing it.
    VersionRegistry.verify();
  }
}
