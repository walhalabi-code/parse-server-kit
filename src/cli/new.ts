import {existsSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  generateKey,
  isUsableTarget,
  replaceTokens,
  scaffold,
  validateProjectName,
  type ScaffoldOptions,
} from './scaffold';
import {AI_TARGETS, resolveTargets, writeAiFiles} from './ai';
import {ask, bold, choose, cyan, dim, fail, info, ok, warn} from './ui';

export interface NewCommandOptions {
  name?: string;
  yes?: boolean;
  force?: boolean;
  kitVersion: string;
  /** From `--ai=claude,cursor`. `undefined` means ask; `[]` means none. */
  ai?: string[];
  /** `--no-install`. Skips the dependency install after scaffolding. */
  skipInstall?: boolean;
}

/**
 * Which assistants to offer by default.
 *
 * `AGENTS.md` alone, because it is the convention several tools already read
 * and it costs one file. Anything tool-specific should be a choice the user
 * makes, not a directory that appears in their repository unasked.
 */
const DEFAULT_AI: string[] = ['agents'];

/**
 * `psk new <name>` — write a runnable project.
 *
 * The generated project is the one thing a stranger judges this library by, so
 * it must work on the first try: correct boot order, both mandatory tsconfig
 * flags already set, a seed so the first POST does not answer 400, and a
 * MongoDB replica set so transactions are not a later surprise.
 */
export async function runNew(options: NewCommandOptions): Promise<number> {
  const suggested = options.name || 'my-api';

  const projectName = options.yes
    ? suggested
    : await ask(`${bold('Project name')}`, suggested);

  const invalid = validateProjectName(projectName);
  if (invalid) {
    fail(invalid);
    return 1;
  }

  const targetDir = resolve(process.cwd(), options.name ?? projectName);

  if (!options.force && !isUsableTarget(targetDir)) {
    fail(`${targetDir} already exists and is not empty.`);
    info(dim('  Use --force to write into it anyway.'));
    return 1;
  }

  const appId = options.yes
    ? projectName
    : await ask(`${bold('Parse app id')}`, projectName);

  // Asked before anything is written, so the whole run is one uninterrupted
  // set of questions followed by one set of results.
  const aiIds = await pickAiTargets(options);
  const {targets, unknown} = resolveTargets(aiIds);
  for (const id of unknown) warn(`Unknown assistant "${id}" — ignored.`);

  const scaffoldOptions: ScaffoldOptions = {
    projectName,
    targetDir,
    appId,
    masterKey: generateKey(),
    maintenanceKey: generateKey(),
    kitVersion: options.kitVersion,
    force: options.force,
  };

  const created = scaffold(scaffoldOptions);

  // After the project, so a failure here cannot leave a half-written project
  // behind — and so the AI files land in a directory that already exists.
  const ai = writeAiFiles(targets, {
    targetDir,
    substitute: text => replaceTokens(text, scaffoldOptions),
    force: options.force,
  });

  const folder = basename(targetDir);

  info();
  ok(`Created ${bold(folder)} — ${created.length + ai.written.length} files`);

  if (ai.written.length > 0) {
    info();
    info(bold('  Instructions for your assistant:'));
    info();
    for (const file of ai.written) info(`    ${cyan(file)}`);
    info();
    info(dim('  These cover the mistakes Parse Server does not warn you about —'));
    info(dim('  shadowed fields, decorator order, the implementACL signature.'));
  }
  for (const file of ai.skipped) {
    warn(`${file} ${dim('(exists, left alone — pass --force to replace)')}`);
  }

  warnIfNested(targetDir, folder);

  const installed = options.skipInstall ? false : installDependencies(targetDir);

  info();
  info(bold('  Next:'));
  info();
  info(`    cd ${folder}`);
  info(`    npm run db:up             ${dim('# MongoDB (replica set, so transactions work)')}`);
  if (!installed) info('    npm install');
  info('    npm run dev');
  info();
  info(dim('  The server prints a ready-to-paste curl on startup,'));
  info(dim('  including a session token for the seeded demo user.'));
  info();
  info(`  No Docker? Put an Atlas connection string in ${cyan('.env')} as ${cyan('DATABASE_URI')}.`);
  info();

  return 0;
}

/**
 * Install the generated project's dependencies.
 *
 * Scaffolding a project that cannot run until the user reads the next line of
 * output is a needless step, and every other `create-*` tool in the ecosystem
 * does this. `--no-install` opts out, for CI and for anyone on a different
 * package manager.
 *
 * A failure here is reported and then ignored: the project on disk is complete
 * and correct either way, and `npm install` is a thing the user can run
 * themselves. Returning `false` puts that line back in the next steps.
 */
function installDependencies(targetDir: string): boolean {
  info();
  info(dim('  Installing dependencies…'));

  const result = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: targetDir,
    stdio: 'ignore',
    // npm is a shell script on Windows, so it is not directly executable.
    shell: process.platform === 'win32',
  });

  if (result.status === 0) {
    ok('Dependencies installed');
    return true;
  }

  warn('Could not install dependencies automatically — run `npm install` yourself.');
  return false;
}

/**
 * Say so when the new project lands inside another npm project.
 *
 * `npm install` in the parent will not install the child, and a `node_modules`
 * one level up resolves for imports while being invisible in the project's own
 * package.json. Nothing here is broken, but the arrangement is confusing enough
 * to be worth one line rather than left to be discovered.
 */
function warnIfNested(targetDir: string, folder: string): void {
  const parent = dirname(targetDir);
  if (!existsSync(join(parent, 'package.json'))) return;

  info();
  warn(`${folder} is inside another npm project.`);
  info(dim('  It is a separate project with its own package.json and its own'));
  info(dim('  dependencies — install and run it from inside the folder.'));
}

/**
 * Decide which assistants to write for.
 *
 * `--ai=` wins outright, including `--ai=none`. `--yes` takes the default
 * without asking. Otherwise the user picks, and a non-TTY takes the default,
 * so this stays usable unattended without threading `--yes` everywhere.
 */
async function pickAiTargets(options: NewCommandOptions): Promise<string[]> {
  if (options.ai !== undefined) return options.ai;
  if (options.yes) return DEFAULT_AI;

  return choose(
    'Which AI coding assistants do you use?',
    AI_TARGETS.map(t => ({id: t.id, label: t.label, summary: t.summary})),
    DEFAULT_AI
  );
}
