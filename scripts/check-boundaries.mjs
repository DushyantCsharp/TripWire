// Enforces CLAUDE.md's dependency direction on package.json manifests, complementing the eslint
// import rules: nothing depends on an app or evals, and packages/agent has no database dependency.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const DATABASE_DEPS = new Set(['@tripwire/db', 'drizzle-orm', 'pg', 'postgres', '@types/pg']);

const dirs = [
  ...['apps', 'packages', 'tooling'].flatMap((group) =>
    readdirSync(join(root, group)).map((name) => join(group, name)),
  ),
  'evals',
].filter((dir) => existsSync(join(root, dir, 'package.json')));

const workspaces = dirs.map((dir) => ({
  dir,
  manifest: JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')),
}));

const consumers = new Set(
  workspaces
    .filter(({ dir }) => dir.startsWith('apps/') || dir === 'evals')
    .map(({ manifest }) => manifest.name),
);

const violations = [];
for (const { dir, manifest } of workspaces) {
  const deps = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  });
  for (const dep of deps) {
    if (consumers.has(dep)) {
      violations.push(`${dir} depends on ${dep}: nothing may depend on an app or evals`);
    }
    if (dir === 'packages/agent' && DATABASE_DEPS.has(dep)) {
      violations.push(`${dir} depends on ${dep}: packages/agent has no database access`);
    }
  }
}

if (violations.length > 0) {
  console.error(`Package boundary violations:\n${violations.map((v) => `  - ${v}`).join('\n')}`);
  process.exit(1);
}
console.log(`Package boundaries OK (${workspaces.length} workspaces).`);
