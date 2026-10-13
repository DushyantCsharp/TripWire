// node --test 'scripts/**/*.test.mjs' (pnpm test:scripts)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { forcesAll, summarise } from './affected-workspaces.mjs';

describe('forcesAll', () => {
  for (const path of [
    'jest.config.js',
    'package.json',
    'pnpm-workspace.yaml',
    'turbo.json',
    '.nvmrc',
    '.github/workflows/ci.yml',
    'infra/docker-compose.yml',
    'runbooks/payment.md',
    'scripts/check-boundaries.mjs',
    'tooling/jest/global-setup.js',
  ]) {
    it(`widens to every workspace for ${path}`, () => assert.equal(forcesAll([path]), true));
  }

  for (const path of [
    'packages/db/src/schema.ts',
    'evals/alert-rules.yaml',
    'CLAUDE.md',
    'pnpm-lock.yaml',
    'apps/api/package.json',
  ]) {
    it(`leaves ${path} to turbo`, () => assert.equal(forcesAll([path]), false));
  }
});

describe('summarise', () => {
  const withJest = new Set(['apps/worker', 'packages/db', 'packages/agent', 'evals']);
  const hasJest = (dir) => withJest.has(dir);
  const pkg = (name, path) => ({ name, path });

  it('lists the affected workspaces that have tests, and filters turbo by the base', () => {
    const packages = [
      pkg('@tripwire/worker', 'apps/worker'),
      pkg('@tripwire/db', 'packages/db'),
      pkg('@tripwire/eslint-config', 'tooling/eslint'),
      pkg('@tripwire/console', 'apps/console'),
    ];
    assert.deepEqual(summarise(packages, { all: false, base: 'abc123', hasJest }), {
      all: false,
      any: true,
      filter: '...[abc123]',
      workspaces: 'apps/worker,packages/db',
      db: true,
    });
  });

  it('needs no filter when everything is affected', () => {
    const summary = summarise([pkg('@tripwire/agent', 'packages/agent')], {
      all: true,
      base: 'abc123',
      hasJest,
    });
    assert.equal(summary.filter, '');
    assert.equal(summary.db, false);
  });

  it('says when nothing is affected', () => {
    assert.deepEqual(summarise([], { all: false, base: 'abc123', hasJest }), {
      all: false,
      any: false,
      filter: '...[abc123]',
      workspaces: '',
      db: false,
    });
  });
});
