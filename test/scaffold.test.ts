import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  generateKey,
  isUsableTarget,
  scaffold,
  templateRoot,
  validateProjectName,
} from '../src/cli/scaffold';

/**
 * The generated project is what a stranger judges this library by, so a broken
 * template is worse than a broken feature — it fails at the first thing anyone
 * does. These tests scaffold for real and assert on the result.
 *
 * They deliberately check the two things that fail *silently* in a generated
 * project: the mandatory tsconfig flags, and leftover tokens.
 */

const base = {
  projectName: 'test-api',
  appId: 'test-api',
  masterKey: 'MASTER',
  maintenanceKey: 'MAINT',
  kitVersion: '9.9.9',
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'psk-scaffold-'));
});

afterEach(() => {
  rmSync(dir, {recursive: true, force: true});
});

describe('validateProjectName', () => {
  it.each(['my-api', 'api', 'a1', 'my.api', 'my_api'])('accepts %s', name => {
    expect(validateProjectName(name)).toBeUndefined();
  });

  it.each([
    ['', 'required'],
    ['My-Api', 'lowercase'],
    ['.hidden', 'dot'],
    ['_private', 'underscore'],
    ['has space', 'lowercase letters'],
  ])('rejects %s', (name, hint) => {
    expect(validateProjectName(name)).toEqual(expect.stringContaining(hint));
  });
});

describe('generateKey', () => {
  it('is long enough to be a secret', () => {
    expect(generateKey().length).toBeGreaterThanOrEqual(32);
  });

  it('does not repeat — it must not come from Math.random', () => {
    const keys = new Set(Array.from({length: 200}, () => generateKey()));
    expect(keys.size).toBe(200);
  });
});

describe('scaffold', () => {
  it('finds its own templates', () => {
    expect(existsSync(templateRoot())).toBe(true);
  });

  it('writes the expected project', () => {
    const target = join(dir, 'app');
    const files = scaffold({...base, targetDir: target});

    expect(files).toEqual(
      expect.arrayContaining([
        '.env',
        '.env.example',
        '.gitignore',
        'README.md',
        'docker-compose.yml',
        'package.json',
        'tsconfig.json',
        'src/app.ts',
        'src/models/Note.ts',
        'src/functions/note.ts',
      ])
    );
  });

  it('writes no byte order mark — package.json must stay JSON.parse-able', () => {
    // Templates get edited on Windows, where a BOM is easy to introduce; one
    // at the top of package.json breaks every strict JSON reader.
    const target = join(dir, 'app');
    const files = scaffold({...base, targetDir: target});

    for (const file of files) {
      const content = readFileSync(join(target, file), 'utf8');
      expect(content.charCodeAt(0)).not.toBe(0xfeff);
    }
  });

  it('leaves no unsubstituted token anywhere', () => {
    const target = join(dir, 'app');
    const files = scaffold({...base, targetDir: target});

    for (const file of files) {
      const content = readFileSync(join(target, file), 'utf8');
      expect(content).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
  });

  it('substitutes the values it was given', () => {
    const target = join(dir, 'app');
    scaffold({...base, targetDir: target, projectName: 'shop', appId: 'shop-id'});

    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('shop');
    expect(pkg.dependencies['parse-server-kit']).toBe('^9.9.9');
    expect(readFileSync(join(target, '.env'), 'utf8')).toContain('APP_ID=shop-id');
  });

  it('renames the files npm would otherwise mangle', () => {
    const target = join(dir, 'app');
    scaffold({...base, targetDir: target});

    // npm strips a file named .gitignore from published tarballs, so the
    // template ships it as `gitignore` and it is renamed here.
    expect(existsSync(join(target, '.gitignore'))).toBe(true);
    expect(existsSync(join(target, 'gitignore'))).toBe(false);
    expect(existsSync(join(target, 'package.json'))).toBe(true);
    expect(existsSync(join(target, 'package.json.template'))).toBe(false);
  });

  it('writes a working .env, not only the example', () => {
    const target = join(dir, 'app');
    scaffold({...base, targetDir: target});
    expect(existsSync(join(target, '.env'))).toBe(true);
  });

  it('declares model fields with `declare`, so no tsconfig can break them', () => {
    // The real fix for accessor shadowing. `title!: string` emits a class
    // field that shadows @ParseField's prototype accessor; `declare` emits
    // nothing, so the accessor is reached under every target and every
    // useDefineForClassFields setting. Verified end to end with the flag
    // deliberately turned on.
    const target = join(dir, 'app');
    scaffold({...base, targetDir: target});

    const model = readFileSync(join(target, 'src/models/Note.ts'), 'utf8');
    const decorated = model.match(/@ParseField\([^)]*\)\s*\n?\s*([^\n;]+);/g) ?? [];

    expect(decorated.length).toBeGreaterThan(0);
    for (const declaration of decorated) {
      expect(declaration).toContain('declare ');
    }
    // and never the shadowing form
    expect(model).not.toMatch(/@ParseField[\s\S]{0,80}?\w+!:\s/);
  });

  describe('the two flags that fail silently', () => {
    it('sets experimentalDecorators — legacy decorators are required', () => {
      const target = join(dir, 'app');
      scaffold({...base, targetDir: target});
      const tsconfig = readFileSync(join(target, 'tsconfig.json'), 'utf8');
      expect(tsconfig).toMatch(/"experimentalDecorators"\s*:\s*true/);
    });

    it('sets useDefineForClassFields false — otherwise every field reads undefined', () => {
      const target = join(dir, 'app');
      scaffold({...base, targetDir: target});
      const tsconfig = readFileSync(join(target, 'tsconfig.json'), 'utf8');
      expect(tsconfig).toMatch(/"useDefineForClassFields"\s*:\s*false/);
    });
  });

  describe('refusing to clobber', () => {
    it('writes into a directory that does not exist', () => {
      expect(isUsableTarget(join(dir, 'nope'))).toBe(true);
    });

    it('writes into an empty directory', () => {
      const target = join(dir, 'empty');
      mkdirSync(target);
      expect(isUsableTarget(target)).toBe(true);
    });

    it('tolerates a git-initialised but otherwise empty directory', () => {
      const target = join(dir, 'gitonly');
      mkdirSync(join(target, '.git'), {recursive: true});
      expect(isUsableTarget(target)).toBe(true);
    });

    it('refuses a directory with real content', () => {
      const target = join(dir, 'used');
      mkdirSync(target);
      writeFileSync(join(target, 'index.js'), '// mine');
      expect(isUsableTarget(target)).toBe(false);
      expect(() => scaffold({...base, targetDir: target})).toThrow(/not empty/);
    });

    it('writes anyway with force, leaving other files alone', () => {
      const target = join(dir, 'used');
      mkdirSync(target);
      writeFileSync(join(target, 'index.js'), '// mine');

      scaffold({...base, targetDir: target, force: true});

      expect(readFileSync(join(target, 'index.js'), 'utf8')).toBe('// mine');
      expect(existsSync(join(target, 'package.json'))).toBe(true);
    });
  });
});
