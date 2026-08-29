import {readdirSync, statSync} from 'fs';
import {extname, join} from 'path';

const isDirectory = (path: string) => statSync(path).isDirectory();

export interface ImportFilesOptions {
  /**
   * Which file extensions to load. Defaults to `['.js']` — the compiled output
   * a production server runs.
   *
   * Pass `['.js', '.ts']` when running straight from source under ts-node or
   * tsx. Without it nothing is imported at all: no models register, no cloud
   * functions exist, and the server starts perfectly happily with an empty
   * schema. It is not the kind of failure you want to debug from the symptoms.
   *
   * Point this at a source directory only. A directory holding *both* compiled
   * and source copies would register every class twice.
   */
  extensions?: string[];
  /** Log each file as it is imported. Defaults to true, as it always has. */
  verbose?: boolean;
}

/**
 * Recursively import every matching file in a directory, for the side effect of
 * running its decorators.
 */
export const importFiles = (
  directoryPath: string,
  options: ImportFilesOptions = {}
) => {
  const {extensions = ['.js'], verbose = true} = options;

  // `.d.ts` is a declaration, never a module to execute — importing one under
  // ts-node is at best a no-op and at worst a crash.
  const wanted = new Set(extensions.map(e => (e.startsWith('.') ? e : `.${e}`)));

  const counts = {imported: 0, passedOver: new Set<string>()};

  const walk = (dir: string): void => {
    for (const file of readdirSync(dir)) {
      const filePath = join(dir, file);
      if (isDirectory(filePath)) {
        walk(filePath);
        continue;
      }

      const ext = extname(filePath);
      if (wanted.has(ext) && !file.endsWith('.d.ts')) {
        if (verbose) console.log(filePath);
        require(filePath);
        counts.imported += 1;
      } else if (ext && !file.endsWith('.d.ts')) {
        counts.passedOver.add(ext);
      }
    }
  };

  walk(directoryPath);

  // Importing nothing is the single easiest way to end up with a server that
  // starts perfectly and has no models, no schema and no routes. It looks like
  // the library did nothing, so say what actually happened.
  if (counts.imported === 0 && counts.passedOver.size > 0) {
    const found = [...counts.passedOver].sort().join(', ');
    const asked = [...wanted].sort().join(', ');
    console.warn(
      `[importFiles] Imported 0 files from ${directoryPath}. ` +
        `Looking for ${asked}, but the only files there are ${found}. ` +
        (counts.passedOver.has('.ts')
          ? "Running from TypeScript sources? Pass {extensions: ['.js', '.ts']}."
          : 'Check the path and the `extensions` option.') +
        ' Nothing has been registered: no models, no cloud functions, no routes.'
    );
  }
};
