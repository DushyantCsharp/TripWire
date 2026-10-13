// Every workspace's Jest projects in one run: `pnpm test:all` (unit and integration) and
// `pnpm coverage`, which CI runs. Each workspace still runs its own projects through turbo
// (`pnpm test`, `pnpm test:integration`).
//
// TRIPWIRE_JEST_WORKSPACES (comma-separated workspace dirs, e.g. `packages/db,apps/worker`) limits
// the run to those workspaces: CI sets it to what a change affects. Coverage and its gate then
// count only those workspaces, so an affected-only run never fails for code it didn't run.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { coverageFrom } from '@tripwire/jest-config';

const root = import.meta.dirname;

/** Every workspace: apps/*, packages/* and evals. */
const WORKSPACES = [
  ...['apps', 'packages'].flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${group}/${entry.name}`)
      .filter((dir) => existsSync(join(root, dir, 'package.json'))),
  ),
  'evals',
];

/** Lines covered by any test in the run, unit or integration, in any workspace. */
const GATED = ['packages/agent', 'packages/db'];

function selectedWorkspaces() {
  const raw = process.env.TRIPWIRE_JEST_WORKSPACES;
  if (raw === undefined) return WORKSPACES;
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = names.filter((name) => !WORKSPACES.includes(name));
  if (names.length === 0 || unknown.length > 0) {
    throw new Error(
      `TRIPWIRE_JEST_WORKSPACES="${raw}" must name workspaces among ${WORKSPACES.join(', ')}`,
    );
  }
  return names;
}

const workspaces = selectedWorkspaces();
const projects = workspaces.flatMap((dir) =>
  ['jest.config.js', 'jest.integration.config.js']
    .map((file) => `${dir}/${file}`)
    .filter((file) => existsSync(join(root, file))),
);
// An empty list would make Jest treat the root as the one project.
if (projects.length === 0) throw new Error(`no Jest projects in ${workspaces.join(', ')}`);

/** @type {import('jest').Config} */
export default {
  projects: projects.map((file) => `<rootDir>/${file}`),
  // A multi-project run reads these from here, not from the projects. One pattern set per
  // workspace: a brace glob with a single entry matches nothing.
  collectCoverageFrom: workspaces.flatMap((dir) => coverageFrom(dir)),
  coverageProvider: 'v8',
  // json-summary feeds CI's job summary (scripts/coverage-summary.mjs).
  coverageReporters: ['text-summary', 'text', 'lcov', 'json-summary'],
  coverageThreshold: Object.fromEntries(
    GATED.filter((dir) => workspaces.includes(dir)).map((dir) => [`./${dir}/src/`, { lines: 80 }]),
  ),
};
