import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

/**
 * Instructions for AI coding assistants, in whichever dialect the user's tool
 * reads.
 *
 * This is worth shipping because of *what* goes wrong with this library. Almost
 * every mistake — a shadowed field, a reversed decorator pair, the wrong
 * `implementACL` shape — produces no error at all: the server starts, the
 * request returns 200, and the data is quietly wrong. A model trained on
 * general TypeScript will reach for `title!: string` and silently break the
 * model, because that is correct everywhere else.
 *
 * One body of rules, written once in `templates/ai/RULES.md`, placed at
 * whatever path each tool looks for. The tools disagree about the filename and
 * almost nothing else.
 */

export interface AiWriteContext {
  /** Project root to write into. */
  targetDir: string;
  /** Token substitution, same as the project scaffolder uses. */
  substitute(text: string): string;
  /** Overwrite files that already exist. */
  force?: boolean;
}

interface Emitted {
  path: string;
  content: string;
}

export interface AiTarget {
  id: string;
  label: string;
  /** Shown next to the label in the prompt, so the choice is concrete. */
  summary: string;
  build(read: TemplateReader): Emitted[];
}

type TemplateReader = {
  rules(): string;
  skill(name: string): string;
  agent(name: string): string;
};

/** Where the shipped AI templates live, whether running from src or dist. */
export function aiTemplateRoot(): string {
  // dist/cli/ai.js -> ../../templates/ai ; src/cli/ai.ts -> ../../templates/ai
  const candidate = resolve(__dirname, '..', '..', 'templates', 'ai');
  if (existsSync(candidate)) return candidate;
  throw new Error(`AI template directory not found at ${candidate}`);
}

function reader(): TemplateReader {
  const root = aiTemplateRoot();
  const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8');
  return {
    rules: () => read('RULES.md'),
    skill: name => read('skills', `${name}.md`),
    agent: name => read('agents', `${name}.md`),
  };
}

/**
 * Cursor reads `.mdc`, which is Markdown with a frontmatter block deciding when
 * the rule is attached. `alwaysApply` is right here: these are not situational
 * hints, they are the difference between working code and silently broken code.
 */
function asCursorRule(body: string): string {
  return [
    '---',
    'description: parse-server-kit conventions and the traps that fail silently',
    'globs: src/**/*.ts',
    'alwaysApply: true',
    '---',
    '',
    body,
  ].join('\n');
}

/**
 * The on-demand skills, in the order a reader would meet them.
 *
 * Each covers one area of the library and, more to the point, the traps in that
 * area that produce no error — a trigger on an undecorated class, a reversed
 * decorator pair, jobs that never run because an optional peer is missing.
 *
 * These are deliberately NOT folded into `RULES.md`: that file is loaded on
 * every request, so breadth there would bury the ten rules that always matter.
 */
const SKILLS = [
  'parse-model',
  'parse-endpoint',
  'parse-permissions',
  'parse-triggers',
  'parse-transactions',
  'parse-jobs',
  'parse-boot',
] as const;

export const AI_TARGETS: AiTarget[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    summary: 'CLAUDE.md, plus seven skills and a review agent',
    build: t => [
      {path: 'CLAUDE.md', content: t.rules()},
      // Skills live in a directory of their own, named by the skill. They load
      // on demand, which is why breadth belongs here rather than in the
      // always-loaded rules file.
      ...SKILLS.map(name => ({
        path: `.claude/skills/${name}/SKILL.md`,
        content: t.skill(name),
      })),
      {path: '.claude/agents/parse-reviewer.md', content: t.agent('parse-reviewer')},
    ],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    summary: '.cursor/rules/parse-server-kit.mdc',
    build: t => [
      {path: '.cursor/rules/parse-server-kit.mdc', content: asCursorRule(t.rules())},
    ],
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    summary: '.github/copilot-instructions.md',
    build: t => [{path: '.github/copilot-instructions.md', content: t.rules()}],
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    summary: '.windsurf/rules/parse-server-kit.md',
    build: t => [{path: '.windsurf/rules/parse-server-kit.md', content: t.rules()}],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    summary: 'GEMINI.md',
    build: t => [{path: 'GEMINI.md', content: t.rules()}],
  },
  {
    id: 'agents',
    label: 'AGENTS.md',
    summary: 'the cross-tool convention — read by several assistants',
    build: t => [{path: 'AGENTS.md', content: t.rules()}],
  },
];

/** Resolve ids from a `--ai=` flag or a prompt answer. Unknown ids are reported. */
export function resolveTargets(ids: string[]): {
  targets: AiTarget[];
  unknown: string[];
} {
  const targets: AiTarget[] = [];
  const unknown: string[] = [];

  for (const raw of ids) {
    const id = raw.trim().toLowerCase();
    if (!id) continue;
    const found = AI_TARGETS.find(t => t.id === id);
    if (found) {
      // Tolerate a repeated id rather than writing the same file twice.
      if (!targets.includes(found)) targets.push(found);
    } else {
      unknown.push(raw);
    }
  }

  return {targets, unknown};
}

/**
 * Write the chosen instruction files.
 *
 * Returns the paths written and the ones left alone. An existing file is never
 * clobbered without `--force`: a project's `CLAUDE.md` is usually hand-edited,
 * and quietly replacing it would be the rudest thing this CLI could do.
 */
export function writeAiFiles(
  targets: AiTarget[],
  context: AiWriteContext
): {written: string[]; skipped: string[]} {
  const t = reader();
  const written: string[] = [];
  const skipped: string[] = [];

  for (const target of targets) {
    for (const file of target.build(t)) {
      const absolute = join(context.targetDir, file.path);

      if (!context.force && existsSync(absolute)) {
        skipped.push(file.path);
        continue;
      }

      mkdirSync(dirname(absolute), {recursive: true});
      writeFileSync(absolute, context.substitute(file.content));
      written.push(file.path);
    }
  }

  return {written, skipped};
}
