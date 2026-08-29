import {existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {toKebabPlural} from '../decorators/routeDecorator';

/**
 * `psk g resource <Name>` — the base files for a new entity.
 *
 * Deliberately not field-driven. It writes a correct skeleton with the edit
 * points marked, because the fields are the part you know and the wiring is
 * the part that is easy to get subtly wrong: the route prefix, `declare` on
 * every field, `fromParams` instead of `set()`, the cast on query results.
 *
 * **Nothing existing is ever modified.** `importFiles` discovers models and
 * functions at boot, so unlike a framework that must patch a module file,
 * this only ever creates. There is no registration step to corrupt.
 */

export interface ResourceNames {
  /** `Product` — the class, and the Parse className. */
  ClassName: string;
  /** `Products`, `Categories` — for method names like `listCategories`. */
  ClassNamePlural: string;
  /** `product` — a local variable, and the functions filename. */
  instanceName: string;
  /** `products` — the REST prefix, from the same helper the router uses. */
  routePrefix: string;
}

export interface ProjectLayout {
  /** Where model files live, absolute. */
  modelsDir: string;
  /** Where the functions file goes, absolute (may be a per-entity folder). */
  functionsDirFor: (names: ResourceNames) => string;
  /** Filename for the functions file. */
  functionsFileFor: (names: ResourceNames) => string;
  /** How the layout was decided, for reporting. */
  describedAs: string;
}

/** `product`, `myThing` — first letter lowered, rest untouched. */
function toInstanceName(className: string): string {
  return className.charAt(0).toLowerCase() + className.slice(1);
}

export function deriveNames(rawName: string): ResourceNames {
  const ClassName = rawName.charAt(0).toUpperCase() + rawName.slice(1);

  // The same function `@Route` uses, so the comments in the generated file
  // cannot drift from the routes the server actually serves.
  const routePrefix = toKebabPlural(ClassName);

  // Back to PascalCase for method names, from that same plural — otherwise a
  // naive `ClassName + 's'` produces `listCategorys` and `listBoxs`.
  const ClassNamePlural = routePrefix
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

  return {
    ClassName,
    ClassNamePlural,
    instanceName: toInstanceName(ClassName),
    routePrefix,
  };
}

/** A class name TypeScript will accept and Parse will not object to. */
export function validateResourceName(name: string): string | undefined {
  if (!name) return 'A resource name is required, e.g. `psk g resource Product`.';
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name))
    return 'Use letters and digits only, starting with a letter (e.g. Product, OrderItem).';
  if (name.startsWith('_'))
    return 'Names starting with an underscore are reserved by Parse.';
  return undefined;
}

/** Directories never worth walking into. */
const SKIP = new Set(['node_modules', '.git', 'build', 'dist', 'coverage']);

/** Find a directory by name under `root`, shallowest match first. */
function findDir(root: string, target: string, depth = 4): string | undefined {
  if (!existsSync(root)) return undefined;
  const queue: Array<{dir: string; level: number}> = [{dir: root, level: 0}];

  while (queue.length) {
    const {dir, level} = queue.shift()!;
    if (level > depth) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (entry === target) return full;
      queue.push({dir: full, level: level + 1});
    }
  }
  return undefined;
}

/**
 * Work out where this project keeps its models and functions.
 *
 * Conventions differ — `src/models` in a generated project, but
 * `src/cloudCode/models` with `src/cloudCode/modules/{Name}/functions.ts` in
 * others. Guessing wrong would drop files where `importFiles` never looks, so
 * the existing tree decides.
 */
export function detectLayout(root: string): ProjectLayout {
  const src = existsSync(join(root, 'src')) ? join(root, 'src') : root;
  const modelsDir = findDir(src, 'models');
  const modulesDir = findDir(src, 'modules');
  const functionsDir = findDir(src, 'functions');

  // A `modules/` tree means one folder per entity, each with functions.ts.
  if (modelsDir && modulesDir) {
    return {
      modelsDir,
      functionsDirFor: names => join(modulesDir, names.ClassName),
      functionsFileFor: () => 'functions.ts',
      describedAs: 'modules/{Name}/functions.ts',
    };
  }

  if (modelsDir && functionsDir) {
    return {
      modelsDir,
      functionsDirFor: () => functionsDir,
      functionsFileFor: names => `${names.instanceName}.ts`,
      describedAs: 'functions/{name}.ts',
    };
  }

  if (modelsDir) {
    const sibling = join(dirname(modelsDir), 'functions');
    return {
      modelsDir,
      functionsDirFor: () => sibling,
      functionsFileFor: names => `${names.instanceName}.ts`,
      describedAs: 'functions/{name}.ts (new)',
    };
  }

  // Nothing to learn from — use the layout `psk new` produces.
  return {
    modelsDir: join(src, 'models'),
    functionsDirFor: () => join(src, 'functions'),
    functionsFileFor: names => `${names.instanceName}.ts`,
    describedAs: 'models/ + functions/ (new)',
  };
}

/** Where the templates live, from src or dist alike. */
function resourceTemplateDir(): string {
  const dir = resolve(__dirname, '..', '..', 'templates', 'resource');
  if (!existsSync(dir)) throw new Error(`Resource templates not found at ${dir}`);
  return dir;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function fill(template: string, values: Record<string, string>): string {
  return Object.keys(values).reduce(
    (acc, key) => acc.split(`{{${key}}}`).join(values[key]),
    template
  );
}

/** An import path from the functions file to the model, POSIX-style. */
export function modelImportPath(functionsDir: string, modelFile: string): string {
  const withoutExt = modelFile.replace(/\.ts$/, '');
  let rel = relative(functionsDir, withoutExt).replace(/\\/g, '/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

export interface GenerateOptions {
  name: string;
  root: string;
  force?: boolean;
  modelOnly?: boolean;
  functionsOnly?: boolean;
}

export interface GenerateResult {
  names: ResourceNames;
  layout: ProjectLayout;
  written: string[];
  skipped: string[];
}

export function generateResource(options: GenerateOptions): GenerateResult {
  const names = deriveNames(options.name);
  const layout = detectLayout(options.root);
  const templates = resourceTemplateDir();

  const modelFile = join(layout.modelsDir, `${names.ClassName}.ts`);
  const functionsDir = layout.functionsDirFor(names);
  const functionsFile = join(functionsDir, layout.functionsFileFor(names));

  const written: string[] = [];
  const skipped: string[] = [];

  const write = (path: string, contents: string) => {
    if (existsSync(path) && !options.force) {
      skipped.push(relative(options.root, path).replace(/\\/g, '/'));
      return;
    }
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, contents);
    written.push(relative(options.root, path).replace(/\\/g, '/'));
  };

  if (!options.functionsOnly) {
    const template = stripBom(
      readFileSync(join(templates, 'model.ts.template'), 'utf8')
    );
    write(modelFile, fill(template, {...names}));
  }

  if (!options.modelOnly) {
    const template = stripBom(
      readFileSync(join(templates, 'functions.ts.template'), 'utf8')
    );
    write(
      functionsFile,
      fill(template, {
        ...names,
        modelImportPath: modelImportPath(functionsDir, modelFile),
      })
    );
  }

  return {names, layout, written, skipped};
}
