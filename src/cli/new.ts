import {basename, resolve} from 'node:path';
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
    info(dim('  These describe the mistakes this library fails silently on —'));
    info(dim('  shadowed fields, decorator order, the implementACL signature.'));
  }
  for (const file of ai.skipped) {
    warn(`${file} ${dim('(exists, left alone — pass --force to replace)')}`);
  }

  info();
  info(bold('  Next:'));
  info();
  info(`    cd ${folder}`);
  info(`    docker compose up -d      ${dim('# MongoDB (replica set, so transactions work)')}`);
  info('    npm install');
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
