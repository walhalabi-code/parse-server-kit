/**
 * Unit tests only — fast, no database, parse-server mocked where touched.
 * Integration tests (test/integration/) run via jest.integration.config.js.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testPathIgnorePatterns: ['/node_modules/', '/test/integration/'],
  setupFiles: ['<rootDir>/test/setup.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {tsconfig: '<rootDir>/tsconfig.test.json'}],
  },
};
