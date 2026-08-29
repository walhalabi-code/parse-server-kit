import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  deriveNames,
  detectLayout,
  generateResource,
  modelImportPath,
  validateResourceName,
} from '../src/cli/generate';
import {toKebabPlural} from '../src/decorators/routeDecorator';

/**
 * `psk g resource` writes base files into an existing project.
 *
 * The two things that must not go wrong: files landing where `importFiles`
 * never looks (so nothing registers, silently), and a route prefix that
 * disagrees with what `@Route` actually serves.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'psk-generate-'));
});

afterEach(() => {
  rmSync(dir, {recursive: true, force: true});
});

/** Build a project skeleton with the given directories. */
function project(...dirs: string[]): string {
  for (const d of dirs) mkdirSync(join(dir, d), {recursive: true});
  return dir;
}

describe('names', () => {
  it('derives class, plural, instance and route names', () => {
    expect(deriveNames('Product')).toEqual({
      ClassName: 'Product',
      ClassNamePlural: 'Products',
      instanceName: 'product',
      routePrefix: 'products',
    });
  });

  it('pluralises method names properly, not by appending s', () => {
    // `listCategorys` and `listBoxs` are what a naive ClassName + 's' gives.
    expect(deriveNames('Category').ClassNamePlural).toBe('Categories');
    expect(deriveNames('Box').ClassNamePlural).toBe('Boxes');
    expect(deriveNames('MenuItem').ClassNamePlural).toBe('MenuItems');
  });

  it('capitalises a lowercase argument', () => {
    expect(deriveNames('invoice').ClassName).toBe('Invoice');
  });

  it('uses the very function @Route uses, so routes cannot disagree', () => {
    for (const name of ['Product', 'Category', 'Box', 'MenuItem', 'Invoice']) {
      expect(deriveNames(name).routePrefix).toBe(toKebabPlural(name));
    }
  });

  it.each([
    ['Category', 'categories'],
    ['Box', 'boxes'],
    ['MenuItem', 'menu-items'],
  ])('%s → %s', (input, expected) => {
    expect(deriveNames(input).routePrefix).toBe(expected);
  });
});

describe('validateResourceName', () => {
  it.each(['Product', 'OrderItem', 'A1'])('accepts %s', name => {
    expect(validateResourceName(name)).toBeUndefined();
  });

  it.each(['', 'my-product', 'my product', '_User', '1Product'])(
    'rejects %s',
    name => {
      expect(validateResourceName(name)).toBeDefined();
    }
  );
});

describe('layout detection', () => {
  it('finds a flat models/ + functions/ project', () => {
    const root = project('src/models', 'src/functions');
    const layout = detectLayout(root);
    expect(layout.modelsDir).toBe(join(root, 'src/models'));
    expect(layout.describedAs).toContain('functions/');
  });

  it('finds a nested cloudCode/models + modules/ project', () => {
    // The shape a real project uses: one folder per entity.
    const root = project('src/cloudCode/models', 'src/cloudCode/modules');
    const layout = detectLayout(root);

    expect(layout.modelsDir).toBe(join(root, 'src/cloudCode/models'));
    expect(layout.describedAs).toBe('modules/{Name}/functions.ts');
    expect(layout.functionsFileFor(deriveNames('Invoice'))).toBe('functions.ts');
    expect(layout.functionsDirFor(deriveNames('Invoice'))).toBe(
      join(root, 'src/cloudCode/modules/Invoice')
    );
  });

  it('falls back to the generated layout for an empty project', () => {
    const root = project('src');
    expect(detectLayout(root).modelsDir).toBe(join(root, 'src/models'));
  });

  it('ignores node_modules when searching', () => {
    const root = project('node_modules/something/models', 'src/models');
    expect(detectLayout(root).modelsDir).toBe(join(root, 'src/models'));
  });
});

describe('modelImportPath', () => {
  it('is relative and POSIX-style, however deep the functions file is', () => {
    expect(
      modelImportPath('/p/src/cloudCode/modules/Invoice', '/p/src/cloudCode/models/Invoice.ts')
    ).toBe('../../models/Invoice');

    expect(modelImportPath('/p/src/functions', '/p/src/models/Product.ts')).toBe(
      '../models/Product'
    );
  });
});

describe('generateResource', () => {
  it('writes both files into the detected layout', () => {
    const root = project('src/models', 'src/functions');
    const {written} = generateResource({name: 'Product', root});

    expect(written).toEqual(['src/models/Product.ts', 'src/functions/product.ts']);
  });

  it('follows a nested modules layout', () => {
    const root = project('src/cloudCode/models', 'src/cloudCode/modules');
    const {written} = generateResource({name: 'Invoice', root});

    expect(written).toEqual([
      'src/cloudCode/models/Invoice.ts',
      'src/cloudCode/modules/Invoice/functions.ts',
    ]);
  });

  it('substitutes every token', () => {
    const root = project('src/models', 'src/functions');
    generateResource({name: 'Product', root});

    for (const file of ['src/models/Product.ts', 'src/functions/product.ts']) {
      expect(readFileSync(join(root, file), 'utf8')).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it('declares fields with `declare`, never the shadowing form', () => {
    const root = project('src/models', 'src/functions');
    generateResource({name: 'Product', root});

    const model = readFileSync(join(root, 'src/models/Product.ts'), 'utf8');
    expect(model).toContain('declare name: string');
    expect(model).not.toMatch(/@ParseField[\s\S]{0,80}?\w+!:\s/);
  });

  it('names the routes the server will actually serve', () => {
    const root = project('src/models', 'src/functions');
    generateResource({name: 'Category', root});

    const fns = readFileSync(join(root, 'src/functions/category.ts'), 'utf8');
    expect(fns).toContain('createCategory');
    expect(fns).toContain('listCategories');
    expect(fns).not.toContain('listCategorys');
    expect(fns).toContain('/api/categories/');
  });

  it('never overwrites an existing file', () => {
    const root = project('src/models', 'src/functions');
    writeFileSync(join(root, 'src/models/Product.ts'), '// my work');

    const {written, skipped} = generateResource({name: 'Product', root});

    expect(skipped).toContain('src/models/Product.ts');
    expect(written).not.toContain('src/models/Product.ts');
    expect(readFileSync(join(root, 'src/models/Product.ts'), 'utf8')).toBe('// my work');
  });

  it('overwrites only when asked', () => {
    const root = project('src/models', 'src/functions');
    writeFileSync(join(root, 'src/models/Product.ts'), '// my work');

    const {written} = generateResource({name: 'Product', root, force: true});
    expect(written).toContain('src/models/Product.ts');
  });

  it('writes only the model when asked', () => {
    const root = project('src/models', 'src/functions');
    const {written} = generateResource({name: 'Product', root, modelOnly: true});

    expect(written).toEqual(['src/models/Product.ts']);
    expect(existsSync(join(root, 'src/functions/product.ts'))).toBe(false);
  });

  it('touches nothing that already exists — no registration to corrupt', () => {
    const root = project('src/models', 'src/functions');
    const appFile = join(root, 'src/app.ts');
    writeFileSync(appFile, 'const boot = 1;');

    generateResource({name: 'Product', root});

    expect(readFileSync(appFile, 'utf8')).toBe('const boot = 1;');
  });
});
