// The library reads `Parse` as a global, the way parse-server provides it.
// Tests run against the real JS SDK so behaviour like `_getSaveJSON`,
// `fromJSON` and subclass registration is the genuine article, not a mock.
import 'reflect-metadata';

// eslint-disable-next-line @typescript-eslint/no-var-requires
(global as Record<string, unknown>).Parse = require('parse/node');
