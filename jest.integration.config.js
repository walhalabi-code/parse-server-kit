/**
 * Integration tests: real parse-server, its real mongodb driver, and an
 * in-memory MongoDB replica set. Slow (first run downloads a MongoDB binary),
 * so they live behind their own config: `npm run test:integration`.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/integration'],
  testMatch: ['**/*.int.test.ts'],
  setupFiles: ['<rootDir>/test/integration/setup.ts'],
  testTimeout: 180000,
  maxWorkers: 1,
  // parse-server keeps sockets and intervals alive that its shutdown does not
  // fully release; without forceExit jest reports results and then hangs.
  forceExit: true,
  transform: {
    '^.+\\.ts$': ['ts-jest', {tsconfig: '<rootDir>/tsconfig.test.json'}],
  },
};
