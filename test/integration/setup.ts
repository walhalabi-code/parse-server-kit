/**
 * The library reads `Parse` as a global, the way parse-server provides it.
 * Integration tests run against the real SDK and a real server, so this only
 * has to exist before any decorated class is imported.
 */
import 'reflect-metadata';

// eslint-disable-next-line @typescript-eslint/no-var-requires
(global as Record<string, unknown>).Parse = require('parse/node');
