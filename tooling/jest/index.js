// Shared Jest presets. Each workspace has a jest.config.js (unit) and, when it has tests against
// real services, a jest.integration.config.js; the root jest.config.js runs them all as projects.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {import('jest').Config} Config */

const here = (specifier) => fileURLToPath(import.meta.resolve(specifier));

// Native ESM: swc strips types and leaves import/export alone (@swc/jest picks ES modules and inline
// source maps), so tests run the same module graph as production. That needs
// node --experimental-vm-modules, which the workspaces' test scripts set.
const swc = {
  jsc: {
    parser: { syntax: 'typescript' },
    // Matches tsconfig, so class fields and imports behave as they do under tsc.
    target: 'es2024',
    keepClassNames: true,
    transform: { useDefineForClassFields: true, verbatimModuleSyntax: true },
  },
};

// ESM-only packages that a CommonJS dependency require()s (fastify's inject → light-my-request →
// cookie). Node 22 allows that; Jest's module loader only does from Node 24.9, so Jest compiles
// these to CommonJS. Everything else in node_modules runs as published.
const requiredEsmOnly = ['cookie'];
const requiredEsmOnlyFiles = `/node_modules/(?:\\.pnpm/[^/]+/node_modules/)?(?:${requiredEsmOnly.join('|')})/.+\\.js$`;

/**
 * What a workspace's coverage counts: its source, minus tests, test helpers and generated code.
 * @param {string} [workspaces] glob for the workspace directories, from the root config
 * @returns {string[]}
 */
export function coverageFrom(workspaces = '.') {
  return [
    `${workspaces}/src/**/*.ts`,
    `!${workspaces}/src/**/*.test.ts`,
    `!${workspaces}/src/**/*.d.ts`,
    `!${workspaces}/src/testing/**`,
    `!${workspaces}/src/generated/**`,
  ];
}

/**
 * @param {string} dir the workspace directory (pass import.meta.dirname)
 * @returns {Config}
 */
function base(dir) {
  const { name } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return {
    displayName: name.replace(/^@tripwire\//, ''),
    rootDir: dir,
    testEnvironment: here('jest-environment-node'),
    // Resolve workspace packages to their TypeScript source, as typecheck and dev do, so tests never
    // run against a stale dist/.
    testEnvironmentOptions: { customExportConditions: ['@tripwire/source', 'node', 'node-addons'] },
    resolver: here('./resolver.cjs'),
    extensionsToTreatAsEsm: ['.ts'],
    moduleFileExtensions: ['ts', 'js', 'mjs', 'cjs', 'json'],
    transform: {
      '^.+\\.ts$': [here('@swc/jest'), swc],
      [requiredEsmOnlyFiles]: [here('@swc/jest'), {}],
    },
    transformIgnorePatterns: [
      `/node_modules/(?!(?:\\.pnpm/)?(?:${requiredEsmOnly.join('|')})[@/])`,
    ],
    // describe/it/expect/jest come from `@jest/globals`, imported explicitly like any other module.
    injectGlobals: false,
    restoreMocks: true,
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    collectCoverageFrom: coverageFrom(),
    coverageProvider: 'v8',
  };
}

/**
 * Unit tests: `src/**\/*.test.ts`, no network, no containers.
 * @param {string} dir
 * @param {Config} [overrides]
 * @returns {Config}
 */
export function unit(dir, overrides = {}) {
  const config = base(dir);
  return {
    ...config,
    testMatch: ['<rootDir>/src/**/*.test.ts'],
    testPathIgnorePatterns: [
      ...(config.testPathIgnorePatterns ?? []),
      '\\.integration\\.test\\.ts$',
    ],
    ...overrides,
  };
}

/**
 * Integration tests: `src/**\/*.integration.test.ts`, against Postgres and Redis in containers,
 * started once per Jest run by the global setup. Tests find them with serviceUrl() from
 * `@tripwire/jest-config/services`.
 * @param {string} dir
 * @param {Config} [overrides]
 * @returns {Config}
 */
export function integration(dir, overrides = {}) {
  const config = base(dir);
  return {
    ...config,
    displayName: `${String(config.displayName)}:integration`,
    testMatch: ['<rootDir>/src/**/*.integration.test.ts'],
    globalSetup: here('./global-setup.js'),
    globalTeardown: here('./global-teardown.js'),
    // 60 s for tests and hooks. Container start-up happens in the global setup, which has no limit.
    setupFilesAfterEnv: [here('./integration-timeout.js')],
    ...overrides,
  };
}
