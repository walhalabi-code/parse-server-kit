import {randomBytes} from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {join, resolve} from 'node:path';

export interface ScaffoldOptions {
  projectName: string;
  targetDir: string;
  appId: string;
  masterKey: string;
  maintenanceKey: string;
  kitVersion: string;
  force?: boolean;
}

/**
 * Files whose template name differs from the name they must end up with.
 *
 * `.gitignore` is renamed because **npm removes a file with that exact name
 * from a published tarball** — ship it as `gitignore` or it silently will not
 * be there when someone installs the package. `package.json.template` is
 * renamed so npm and every tool that walks node_modules does not treat the
 * template directory as a nested package.
 */
const RENAMES: Record<string, string> = {
  gitignore: '.gitignore',
  'package.json.template': 'package.json',
  // Named .template so an editor does not treat templates/default as a
  // TypeScript project: there is no node_modules beneath it, so every import
  // fails to resolve and the files light up red for whoever is editing them.
  'tsconfig.json.template': 'tsconfig.json',
  'env.example': '.env.example',
};

/** Files that are copied byte-for-byte, never scanned for tokens. */
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2']);

/** A secret, from a real source of randomness — not `Math.random`. */
export function generateKey(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * npm's rules, near enough: what may be a package name and a folder name.
 * Returns an error message, or nothing if the name is fine.
 */
export function validateProjectName(name: string): string | undefined {
  if (!name) return 'A project name is required.';
  if (name.length > 214) return 'Name must be 214 characters or fewer.';
  if (name.startsWith('.') || name.startsWith('_'))
    return 'Name cannot begin with a dot or underscore.';
  if (name !== name.toLowerCase()) return 'Name must be lowercase.';
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name))
    return 'Use lowercase letters, digits, dashes, dots and underscores only.';
  return undefined;
}

/** Where the shipped templates live, whether running from src or dist. */
export function templateRoot(): string {
  // dist/cli/scaffold.js → ../../templates ; src/cli/scaffold.ts → ../../templates
  const candidate = resolve(__dirname, '..', '..', 'templates', 'default');
  if (existsSync(candidate)) return candidate;
  throw new Error(`Template directory not found at ${candidate}`);
}

/** Whether a directory is absent, empty, or holds only innocuous entries. */
export function isUsableTarget(dir: string): boolean {
  if (!existsSync(dir)) return true;
  if (!statSync(dir).isDirectory()) return false;
  const harmless = new Set(['.git', '.gitignore', '.DS_Store', 'README.md', 'LICENSE']);
  return readdirSync(dir).every(entry => harmless.has(entry));
}

/** `split`/`join` rather than `replaceAll`, which needs an ES2021 lib. */
function replaceAll(text: string, token: string, value: string): string {
  return text.split(token).join(value);
}

/**
 * Drop a leading byte order mark.
 *
 * Templates get edited on Windows, where several editors and PowerShell's
 * `Set-Content -Encoding utf8` write UTF-8 **with** a BOM. Copied through
 * verbatim, that BOM lands at the top of the generated `package.json` and
 * `JSON.parse` refuses the file — so a project that looks perfectly normal
 * fails on the first tool that reads it strictly.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function replaceTokens(text: string, options: ScaffoldOptions): string {
  const values: Record<string, string> = {
    '{{PROJECT_NAME}}': options.projectName,
    '{{APP_ID}}': options.appId,
    '{{MASTER_KEY}}': options.masterKey,
    '{{MAINTENANCE_KEY}}': options.maintenanceKey,
    '{{KIT_VERSION}}': options.kitVersion,
  };
  return Object.keys(values).reduce(
    (acc, token) => replaceAll(acc, token, values[token]),
    text
  );
}

/**
 * Write the template into `targetDir`, substituting tokens as it goes.
 *
 * Returns every file created, relative to the target, so the caller can report
 * and the tests can assert on it.
 */
export function scaffold(options: ScaffoldOptions): string[] {
  const source = templateRoot();
  const target = resolve(options.targetDir);

  if (!options.force && !isUsableTarget(target)) {
    throw new Error(
      `${target} already exists and is not empty. Use --force to write into it anyway.`
    );
  }

  mkdirSync(target, {recursive: true});
  const written: string[] = [];

  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(source, relative))) {
      const from = join(source, relative, entry);
      const renamed = RENAMES[entry] ?? entry;
      const to = join(target, relative, renamed);

      if (statSync(from).isDirectory()) {
        mkdirSync(to, {recursive: true});
        walk(join(relative, entry));
        continue;
      }

      const isBinary = [...BINARY_EXTENSIONS].some(ext => entry.endsWith(ext));
      if (isBinary) {
        cpSync(from, to);
      } else {
        writeFileSync(
          to,
          replaceTokens(stripBom(readFileSync(from, 'utf8')), options)
        );
      }
      written.push(join(relative, renamed).replace(/\\/g, '/'));
    }
  };

  try {
    walk('');
  } catch (error) {
    // A half-written project is worse than none: it looks installable and is
    // not. Only clean up a directory this run created.
    if (!options.force && !existsSync(join(target, 'package.json'))) {
      rmSync(target, {recursive: true, force: true});
    }
    throw error;
  }

  // `.env.example` is the file people copy; give them a working `.env` too, so
  // the project runs before they have read anything.
  const envExample = join(target, '.env.example');
  const envFile = join(target, '.env');
  if (existsSync(envExample) && !existsSync(envFile)) {
    writeFileSync(envFile, readFileSync(envExample, 'utf8'));
    written.push('.env');
  }

  return written.sort();
}

export {RENAMES, renameSync};
