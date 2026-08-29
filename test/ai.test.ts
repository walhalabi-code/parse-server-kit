import 'reflect-metadata';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {AI_TARGETS, aiTemplateRoot, resolveTargets, writeAiFiles} from '../src/cli/ai';

/**
 * The AI instruction files exist because of *what* goes wrong with this
 * library: a shadowed field, a reversed decorator pair or the wrong
 * `implementACL` shape all produce no error at all. A model trained on general
 * TypeScript will confidently write `title!: string` and silently break the
 * model, because that is correct everywhere else.
 *
 * So these tests do two jobs. The mechanical one — paths, substitution, not
 * clobbering. And a content check, because a rules file that has quietly lost
 * the rule about `declare` is worse than no file: it looks authoritative and
 * omits the thing that matters.
 */

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'psk-ai-'));
});

afterEach(() => {
  rmSync(workspace, {recursive: true, force: true});
});

const substitute = (text: string) => text.split('{{PROJECT_NAME}}').join('demo-api');

const write = (targets = AI_TARGETS, force = false) =>
  writeAiFiles(targets, {targetDir: workspace, substitute, force});

const read = (relative: string) => readFileSync(join(workspace, relative), 'utf8');

describe('the shipped templates', () => {
  it('are where the CLI expects them', () => {
    expect(existsSync(aiTemplateRoot())).toBe(true);
  });

  it('every target builds without a missing template file', () => {
    // Guards a typo in a skill or agent name, which would otherwise only
    // surface as an ENOENT for whoever picked that assistant.
    for (const target of AI_TARGETS) {
      expect(() => write([target])).not.toThrow();
    }
  });

  it('gives every target a unique id', () => {
    const ids = AI_TARGETS.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('describes what each target writes, so the prompt is concrete', () => {
    for (const target of AI_TARGETS) {
      expect(target.label.length).toBeGreaterThan(0);
      expect(target.summary.length).toBeGreaterThan(0);
    }
  });
});

describe('the rules themselves', () => {
  beforeEach(() => write([AI_TARGETS.find(t => t.id === 'agents')!]));

  it.each([
    ['declare', 'the field-shadowing trap'],
    ['@Transactional', 'decorator order'],
    ['implementACL', 'the ACL signature'],
    ['targetClass', 'pointers and arrays'],
    ['fromParams', 'request decoding'],
    ['catchError', 'the error convention'],
    ['@ParseClass', 'triggers needing a decorated class'],
  ])('still covers %s (%s)', token => {
    expect(read('AGENTS.md')).toContain(token);
  });

  it('shows the wrong form next to the right one for field declaration', () => {
    // A rule stated only in the abstract is easy to misapply. The file has to
    // show `title!: string` being wrong, not just say "use declare".
    const body = read('AGENTS.md');
    expect(body).toContain('declare title: string');
    expect(body).toContain('title!: string');
  });

  it('states the decorator order concretely, not as a principle', () => {
    const body = read('AGENTS.md');
    expect(body).toMatch(/@CloudFunction[\s\S]{0,200}@Transactional/);
  });

  it('warns against trusting the body for identity', () => {
    expect(read('AGENTS.md')).toContain('req.user!');
  });
});

describe('writeAiFiles', () => {
  it('writes AGENTS.md at the repository root', () => {
    const {written} = write([AI_TARGETS.find(t => t.id === 'agents')!]);
    expect(written).toEqual(['AGENTS.md']);
    expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(true);
  });

  it('puts each Claude skill in a directory of its own, named SKILL.md', () => {
    const {written} = write([AI_TARGETS.find(t => t.id === 'claude')!]);
    expect(written).toEqual([
      'CLAUDE.md',
      '.claude/skills/parse-model/SKILL.md',
      '.claude/skills/parse-endpoint/SKILL.md',
      '.claude/skills/parse-permissions/SKILL.md',
      '.claude/skills/parse-triggers/SKILL.md',
      '.claude/skills/parse-transactions/SKILL.md',
      '.claude/skills/parse-jobs/SKILL.md',
      '.claude/skills/parse-boot/SKILL.md',
      '.claude/agents/parse-reviewer.md',
    ]);
  });

  it('creates nested directories that do not exist yet', () => {
    write([AI_TARGETS.find(t => t.id === 'cursor')!]);
    expect(existsSync(join(workspace, '.cursor', 'rules', 'parse-server-kit.mdc'))).toBe(true);
  });

  it('substitutes the project name', () => {
    write([AI_TARGETS.find(t => t.id === 'agents')!]);
    const body = read('AGENTS.md');
    expect(body).toContain('demo-api');
    expect(body).not.toContain('{{PROJECT_NAME}}');
  });

  it('leaves no unsubstituted token in any file, for any target', () => {
    const {written} = write();
    for (const file of written) {
      expect(read(file)).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
  });

  it('gives the Cursor rule the frontmatter Cursor reads', () => {
    write([AI_TARGETS.find(t => t.id === 'cursor')!]);
    const body = read('.cursor/rules/parse-server-kit.mdc');
    expect(body.startsWith('---\n')).toBe(true);
    expect(body).toContain('alwaysApply: true');
    expect(body).toContain('globs: src/**/*.ts');
  });

  it('keeps the frontmatter on every Claude skill', () => {
    const {written} = write([AI_TARGETS.find(t => t.id === 'claude')!]);
    const skills = written.filter(f => f.endsWith('/SKILL.md'));
    expect(skills.length).toBeGreaterThanOrEqual(7);

    for (const path of skills) {
      // ".claude/skills/parse-model/SKILL.md" -> "parse-model"
      const name = path.split('/')[2];
      const body = read(path);
      expect(body.startsWith('---\n')).toBe(true);
      // The name in the frontmatter must match the directory, or the skill
      // will not resolve.
      expect(body).toContain(`name: ${name}`);
      expect(body).toContain('description:');
    }
  });

  it('gives every skill a description that says when to use it', () => {
    const {written} = write([AI_TARGETS.find(t => t.id === 'claude')!]);
    for (const path of written.filter(f => f.endsWith('/SKILL.md'))) {
      const description = read(path).match(/^description:\s*(.+)$/m)?.[1] ?? '';
      // A description is how the model decides whether to load the skill at
      // all. One that does not say when it applies is dead weight.
      expect(description.length).toBeGreaterThan(60);
      expect(description).toMatch(/Use when/i);
    }
  });

  it('gives the review agent a tool list', () => {
    write([AI_TARGETS.find(t => t.id === 'claude')!]);
    const body = read('.claude/agents/parse-reviewer.md');
    expect(body).toContain('name: parse-reviewer');
    expect(body).toContain('tools:');
  });

  it('writes every target at once without collision', () => {
    const {written, skipped} = write();
    expect(skipped).toEqual([]);
    // One path per file, no duplicates.
    expect(new Set(written).size).toBe(written.length);
    for (const file of written) expect(existsSync(join(workspace, file))).toBe(true);
  });

  describe('files that already exist', () => {
    beforeEach(() => {
      const path = join(workspace, 'CLAUDE.md');
      mkdirSync(dirname(path), {recursive: true});
      writeFileSync(path, 'hand written, do not clobber');
    });

    it('leaves them alone by default', () => {
      // A project's CLAUDE.md is usually hand-edited. Replacing it silently
      // would be the rudest thing this CLI could do.
      const {written, skipped} = write([AI_TARGETS.find(t => t.id === 'claude')!]);
      expect(skipped).toContain('CLAUDE.md');
      expect(written).not.toContain('CLAUDE.md');
      expect(read('CLAUDE.md')).toBe('hand written, do not clobber');
    });

    it('still writes the ones that do not exist', () => {
      const {written} = write([AI_TARGETS.find(t => t.id === 'claude')!]);
      expect(written).toContain('.claude/agents/parse-reviewer.md');
    });

    it('replaces them with force', () => {
      const {written, skipped} = write([AI_TARGETS.find(t => t.id === 'claude')!], true);
      expect(written).toContain('CLAUDE.md');
      expect(skipped).toEqual([]);
      expect(read('CLAUDE.md')).not.toBe('hand written, do not clobber');
    });
  });
});

describe('coverage of the public API', () => {
  /** Every value exported from the package entry point. */
  function publicExports(): string[] {
    const index = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    const names: string[] = [];

    for (const block of index.matchAll(/export \{([^}]*)\} from/g)) {
      for (const raw of block[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
        // `export type {…}` blocks are types, not things you call.
        if (name && /^[A-Za-z_$][\w$]*$/.test(name) && !raw.includes('type ')) {
          names.push(name);
        }
      }
    }
    return [...new Set(names)];
  }

  /** Everything the shipped AI templates say, concatenated. */
  function aiCorpus(): string {
    const root = aiTemplateRoot();
    const parts: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else parts.push(readFileSync(full, 'utf8'));
      }
    };
    walk(root);
    return parts.join('\n');
  }

  /**
   * Deliberately out of scope: integration hooks, introspection helpers and
   * adapter internals. Naming them in the instructions would cost signal
   * without ever changing what gets written.
   */
  const OUT_OF_SCOPE = new Set([
    'onClassRegistered',
    'onFieldRegistered',
    'onFunctionRegistered',
    'getSchemaDefinition',
    'classNames',
    'SwaggerRegistry',
    'withAmbientSession',
    'NO_AMBIENT_TRANSACTION',
    'applyUniqueIndexes', // permanent alias for applyAllIndexes
    'useTransactionAdapter',
    'resetKitConfig', // test-only
  ]);

  it('mentions every export an author would reach for', () => {
    const corpus = aiCorpus();
    const missing = publicExports()
      .filter(name => !OUT_OF_SCOPE.has(name))
      .filter(name => !corpus.includes(name));

    // Fails with the names, so adding an export without documenting it for an
    // assistant is caught here rather than noticed a year later.
    expect(missing).toEqual([]);
  });

  it('keeps the always-loaded rules file from sprawling', () => {
    // RULES.md is loaded on every request. Breadth belongs in the skills,
    // which load on demand; if this file grows without bound the ten rules
    // that always matter get buried.
    const rules = readFileSync(join(aiTemplateRoot(), 'RULES.md'), 'utf8');
    expect(rules.length).toBeLessThan(16_000);
  });
});

describe('resolveTargets', () => {
  it('resolves known ids', () => {
    const {targets, unknown} = resolveTargets(['claude', 'cursor']);
    expect(targets.map(t => t.id)).toEqual(['claude', 'cursor']);
    expect(unknown).toEqual([]);
  });

  it('reports unknown ids without discarding the good ones', () => {
    const {targets, unknown} = resolveTargets(['claude', 'nonsense']);
    expect(targets.map(t => t.id)).toEqual(['claude']);
    expect(unknown).toEqual(['nonsense']);
  });

  it('is case insensitive and tolerates whitespace', () => {
    const {targets} = resolveTargets([' Claude ', 'CURSOR']);
    expect(targets.map(t => t.id)).toEqual(['claude', 'cursor']);
  });

  it('de-duplicates, so a repeated id does not write the file twice', () => {
    const {targets} = resolveTargets(['agents', 'agents']);
    expect(targets.map(t => t.id)).toEqual(['agents']);
  });

  it('ignores empty entries from a trailing comma', () => {
    const {targets, unknown} = resolveTargets(['agents', '', '  ']);
    expect(targets.map(t => t.id)).toEqual(['agents']);
    expect(unknown).toEqual([]);
  });

  it('resolves nothing from an empty list', () => {
    expect(resolveTargets([]).targets).toEqual([]);
  });
});
