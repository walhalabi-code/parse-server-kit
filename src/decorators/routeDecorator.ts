import 'reflect-metadata';
import {CloudFunctionRegistry} from './cloudRegistry';
import {SwaggerRegistry} from '../swagger/swaggerRegistry';

/**
 * @Route decorator — maps cloud functions to entity-based routes.
 *
 * Usage:
 *   @Route(Student)           // reads JS class name → 'Student' → /api/students/*
 *   @Route('school-students') // custom string → /api/school-students/*
 *
 * The decorator captures the class's static method names and registers them
 * with RouteRegistry. At server init, the registry builds the route map.
 */

/**
 * Convert PascalCase to kebab-case plural for route prefix.
 * 'Student' → 'students'
 * 'MenuItem' → 'menu-items'
 * 'MeetingMinute' → 'meeting-minutes'
 */
export function toKebabPlural(name: string): string {
  const kebab = name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
  if (kebab.endsWith('y') && !kebab.endsWith('ay') && !kebab.endsWith('ey') && !kebab.endsWith('oy')) {
    return kebab.slice(0, -1) + 'ies';
  }
  if (kebab.endsWith('s') || kebab.endsWith('sh') || kebab.endsWith('ch') || kebab.endsWith('x')) {
    return kebab + 'es';
  }
  return kebab + 's';
}

/**
 * @Route class decorator.
 * Accepts a Parse model class (reads JS class name) or a custom string.
 */
export function Route(target: Function | string) {
  return function (constructor: Function) {
    let prefix: string;
    let jsClassName: string;

    if (typeof target === 'string') {
      prefix = target;
      jsClassName = target;
    } else {
      // Use JS class name (target.name), NOT Parse className
      // Parse className could be '_User' which breaks matching
      jsClassName = target.name;
      prefix = toKebabPlural(jsClassName);
    }

    // Capture method names from both prototype (instance) and static
    const protoMethods = Object.getOwnPropertyNames(constructor.prototype)
      .filter(name => name !== 'constructor' && typeof constructor.prototype[name] === 'function');
    const staticMethods = Object.getOwnPropertyNames(constructor)
      .filter(name => !['length', 'name', 'prototype'].includes(name) && typeof (constructor as any)[name] === 'function');
    const methodNames = [...protoMethods, ...staticMethods];

    RouteRegistry.register(jsClassName, prefix, methodNames);
  };
}

/**
 * Whether `path` is the prefix itself or sits beneath it, by whole segments.
 *
 * A bare `startsWith` matches on characters, so `/users` also matches
 * `/users-export` and `/functions` also matches `/functionsX`. That is the
 * wrong answer wherever the result decides whether a request is allowed
 * through: a `@Route('user')` prefix would open every path beginning `/user`,
 * Parse's own `/users` table endpoints included — the ones this library
 * documents as blocked.
 *
 * Matching a whole segment means `/users` matches `/users` and `/users/me`,
 * and nothing else.
 */
export function isUnderPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Global route registry — maps route prefixes to function names.
 */
export class RouteRegistry {
  // jsClassName → { prefix, methodNames }
  private static entries: Map<string, { prefix: string; methodNames: string[] }> = new Map();
  // route path → function name
  private static routeMap: Map<string, string> = new Map();
  // registered route prefixes
  private static registeredPrefixes: Set<string> = new Set();

  static register(jsClassName: string, prefix: string, methodNames: string[]) {
    this.entries.set(jsClassName, { prefix, methodNames });
  }

  /**
   * Called after CloudFunctionRegistry.initialize().
   * Uses definitive method lists — no string matching guesswork.
   */
  static initialize() {
    const functions = CloudFunctionRegistry.getFunctions();

    for (const fn of functions) {
      // Find which class owns this function by checking method name lists
      let matchedPrefix: string | null = null;
      let matchedClassName: string | null = null;

      for (const [jsClassName, { prefix, methodNames }] of this.entries) {
        if (methodNames.includes(fn.name)) {
          matchedPrefix = prefix;
          matchedClassName = jsClassName;
          break;
        }
      }

      if (matchedPrefix) {
        const routePath = `/${matchedPrefix}/${fn.name}`;
        this.routeMap.set(routePath, fn.name);
        this.registeredPrefixes.add(`/${matchedPrefix}`);
        fn.routePrefix = matchedPrefix;
        // Document the real REST route in Swagger (not the legacy /functions/).
        SwaggerRegistry.setFunctionPath(fn.name, routePath);
        console.log(`  Route: ${routePath} → ${fn.name}`);
      }
    }

    console.log(`Route registry: ${this.routeMap.size} routes registered`);
  }

  static resolve(routePath: string): string | undefined {
    return this.routeMap.get(routePath);
  }

  static isRegisteredPrefix(path: string): boolean {
    for (const prefix of this.registeredPrefixes) {
      if (isUnderPrefix(path, prefix)) return true;
    }
    return false;
  }

  static getPrefixes(): string[] {
    return Array.from(this.registeredPrefixes);
  }
}
