#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runNew} from './new';
import {generateResource, validateResourceName} from './generate';
import {AI_TARGETS, resolveTargets, writeAiFiles} from './ai';
import {bold, choose, cyan, dim, fail, info, ok, warn} from './ui';

/**
 * `psk` — the parse-server-kit command line.
 *
 * Argument parsing is by hand, because a dependency here would become a
 * dependency of every server that installs this package. The surface is one
 * command and three flags; `commander` would cost more than it saves.
 */

function kitVersion(): string {
  try {
    const pkg = resolve(__dirname, '..', '..', 'package.json');
    return JSON.parse(readFileSync(pkg, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function usage(): void {
  info(`
${bold('psk')} ${dim('— parse-server-kit')}

${bold('Usage')}
  psk new <name>              Create a new Parse Server project
  psk generate resource <Name>  Add a model + CRUD endpoints  ${dim('(alias: g)')}
  psk generate model <Name>     Add a model only
  psk ai [targets]            Add AI assistant instructions to this project
  psk --version               Print the version
  psk --help                  Show this

${bold('Options')}
  -y, --yes                   Accept the defaults, ask nothing      ${dim('(new)')}
  -f, --force                 Overwrite files that already exist
  --no-install                Skip installing dependencies          ${dim('(new)')}
  --ai=<list>                 Assistants to write for, or ${cyan('none')}    ${dim('(new)')}
                              ${dim(AI_TARGETS.map(t => t.id).join(', '))}

${bold('Examples')}
  ${cyan('npx parse-server-kit new my-api')}
  ${cyan('cd my-api && npm run db:up && npm run dev')}

  ${cyan('psk g resource Product')}
  ${dim('  → src/models/Product.ts     and  src/functions/product.ts')}
  ${dim('  → POST /api/products/createProduct, GET /api/products/listProducts, ...')}
  ${dim('  Base files with the edit points marked. Fill in your own fields.')}

  ${cyan('psk ai claude cursor')}
  ${dim('  → CLAUDE.md, .claude/skills/, .claude/agents/, .cursor/rules/')}
  ${dim('  The mistakes Parse Server does not warn you about, in the dialect your tool reads.')}

  ${cyan('psk new my-api --ai=none -y')}
  ${dim('  Unattended, no assistant files.')}
`);
}

/** `--ai=claude,cursor`, `--ai claude,cursor`, or `--ai=none`. */
function parseAiFlag(args: string[]): string[] | undefined {
  const inline = args.find(a => a.startsWith('--ai='));
  if (inline) {
    const value = inline.slice('--ai='.length).trim();
    return value === '' || value === 'none' ? [] : value.split(',');
  }

  const index = args.indexOf('--ai');
  if (index !== -1) {
    const value = args[index + 1];
    if (!value || value.startsWith('-') || value === 'none') return [];
    return value.split(',');
  }

  if (args.includes('--no-ai')) return [];
  return undefined;
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage();
    return 0;
  }

  if (args.includes('--version') || args.includes('-v')) {
    info(kitVersion());
    return 0;
  }

  const [command, ...rest] = args;

  // `create` is accepted because half the ecosystem calls it that.
  if (command === 'new' || command === 'create') {
    const ai = parseAiFlag(rest);
    // Drop the flag's own value so it is not mistaken for the project name.
    const consumed = new Set<string>();
    const bare = rest.indexOf('--ai');
    if (bare !== -1 && rest[bare + 1]) consumed.add(rest[bare + 1]);

    const flags = new Set(rest.filter(a => a.startsWith('-')));
    const name = rest.find(a => !a.startsWith('-') && !consumed.has(a));

    return runNew({
      name,
      yes: flags.has('--yes') || flags.has('-y'),
      force: flags.has('--force') || flags.has('-f'),
      skipInstall: flags.has('--no-install'),
      kitVersion: kitVersion(),
      ai,
    });
  }

  if (command === 'generate' || command === 'g') {
    return runGenerate(rest);
  }

  if (command === 'ai') {
    return runAi(rest);
  }

  fail(`Unknown command: ${command}`);
  info(dim('  Run `psk --help` to see what is available.'));
  return 1;
}

/**
 * `psk ai [targets…]` — add assistant instructions to a project that already
 * exists, for people who skipped the question during `psk new` or who changed
 * tools since.
 *
 * The project name is read from `package.json` so the generated files name the
 * right project; a directory without one still works, it is just less specific.
 */
async function runAi(args: string[]): Promise<number> {
  const flags = new Set(args.filter(a => a.startsWith('-')));
  const named = args.filter(a => !a.startsWith('-'));

  const ids = named.length > 0
    ? named.flatMap(a => a.split(','))
    : await choose(
        'Which AI coding assistants do you use?',
        AI_TARGETS.map(t => ({id: t.id, label: t.label, summary: t.summary})),
        ['agents']
      );

  const {targets, unknown} = resolveTargets(ids);
  for (const id of unknown) warn(`Unknown assistant "${id}" — ignored.`);

  if (targets.length === 0) {
    info();
    info(dim('  Nothing selected.'));
    info(dim(`  Available: ${AI_TARGETS.map(t => t.id).join(', ')}`));
    info();
    return unknown.length > 0 ? 1 : 0;
  }

  const targetDir = process.cwd();

  let projectName = 'this project';
  try {
    projectName =
      JSON.parse(readFileSync(resolve(targetDir, 'package.json'), 'utf8')).name ??
      projectName;
  } catch {
    // No package.json, or an unreadable one. The instructions are still
    // correct; they just say "this project" rather than the name.
  }

  const {written, skipped} = writeAiFiles(targets, {
    targetDir,
    substitute: text => text.split('{{PROJECT_NAME}}').join(projectName),
    force: flags.has('--force') || flags.has('-f'),
  });

  info();
  for (const file of written) ok(file);
  for (const file of skipped) warn(`${file} ${dim('(exists, left alone)')}`);

  if (written.length === 0) {
    info();
    info(dim('  Nothing written. Pass --force to replace what is there.'));
    info();
    return 1;
  }

  info();
  info(dim('  These cover the mistakes Parse Server does not warn you about —'));
  info(dim('  shadowed fields, decorator order, the implementACL signature.'));
  info();

  return 0;
}

/** `psk g resource Product` / `psk g model Product` */
function runGenerate(args: string[]): number {
  const flags = new Set(args.filter(a => a.startsWith('-')));
  const positional = args.filter(a => !a.startsWith('-'));
  const [kind, name] = positional;

  const KINDS = ['resource', 'model', 'functions'];
  if (!kind || !KINDS.includes(kind)) {
    fail(`Expected one of: ${KINDS.join(', ')}`);
    info(dim('  e.g. psk g resource Product'));
    return 1;
  }

  const invalid = validateResourceName(name);
  if (invalid) {
    fail(invalid);
    return 1;
  }

  const result = generateResource({
    name,
    root: process.cwd(),
    force: flags.has('--force') || flags.has('-f'),
    modelOnly: kind === 'model',
    functionsOnly: kind === 'functions',
  });

  const {names, layout, written, skipped} = result;

  info();
  if (written.length === 0) {
    warn('Nothing written — every file already exists.');
    for (const file of skipped) info(dim(`    ${file}`));
    info();
    info(dim('  Pass --force to overwrite.'));
    info();
    return 1;
  }

  for (const file of written) ok(file);
  for (const file of skipped) warn(`${file} ${dim('(exists, left alone)')}`);

  info();
  info(dim(`  Layout: ${layout.describedAs}`));

  if (kind !== 'model') {
    info();
    info(bold('  Routes now available:'));
    info();
    const p = names.routePrefix;
    const C = names.ClassName;
    info(`    POST  /api/${p}/create${C}`);
    info(`    GET   /api/${p}/list${names.ClassNamePlural}`);
    info(`    GET   /api/${p}/get${C}`);
    info(`    POST  /api/${p}/update${C}`);
    info(`    POST  /api/${p}/delete${C}`);
  }

  info();
  info(dim('  Nothing to register — importFiles picks these up at boot.'));
  info(dim('  Open the files and fill in your fields; the edit points are marked.'));
  info();

  return 0;
}

/* istanbul ignore next — the entry point, exercised by the e2e job */
if (require.main === module) {
  main(process.argv)
    .then(code => process.exit(code))
    .catch(error => {
      fail(error?.message ?? String(error));
      process.exit(1);
    });
}

