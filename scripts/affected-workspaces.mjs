// Which workspaces a change affects, for CI (`node scripts/affected-workspaces.mjs <base>`): turbo's
// affected packages (`...[base]`: changed packages and their dependents), widened to every package
// when a file outside all of them changed. turbo files those under the root package `//`, which
// `turbo ls` never lists, so a change to jest.config.js or runbooks/ would otherwise run nothing.
// On GitHub Actions the result goes to $GITHUB_OUTPUT; elsewhere it is printed.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(import.meta.dirname, '..');

/** Files outside the packages whose change can alter any package's checks or tests. */
export const ROOT_INPUTS = [
  /^jest\.config\.js$/,
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^turbo\.json$/,
  /^\.nvmrc$/,
  /^\.github\//,
  /^infra\//,
  /^runbooks\//,
  /^scripts\//,
  /^tooling\//,
];

/** Whether any changed path is a root input, so every workspace counts as affected. */
export function forcesAll(changed) {
  return changed.some((path) => ROOT_INPUTS.some((pattern) => pattern.test(path)));
}

/**
 * The outputs for a set of affected packages (`turbo ls` items).
 * @param {{ name: string, path: string }[]} packages
 * @param {{ all: boolean, base: string, hasJest: (dir: string) => boolean }} options
 */
export function summarise(packages, { all, base, hasJest }) {
  const dirs = packages.map((item) => item.path).sort();
  return {
    all,
    any: packages.length > 0,
    // Every package when everything is affected: turbo needs no filter then.
    filter: all ? '' : `...[${base}]`,
    workspaces: dirs.filter(hasJest).join(','),
    db: packages.some((item) => item.name === '@tripwire/db'),
  };
}

/** The packages `turbo ls` lists, with or without a filter. */
function turboPackages(filter) {
  const args = ['exec', 'turbo', 'ls', ...(filter ? [`--filter=${filter}`] : []), '--output=json'];
  const output = execFileSync('pnpm', args, { cwd: root, encoding: 'utf8' });
  return JSON.parse(output).packages.items;
}

/** Changed paths since the merge base with `base`, or null when there is no usable base. */
function changedSince(base) {
  if (!base || /^0+$/.test(base)) return null;
  try {
    const output = execFileSync('git', ['diff', '--name-only', '--merge-base', base, 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    });
    return output.split('\n').filter(Boolean);
  } catch (error) {
    // An unknown base (a first push, a force push): nothing to compare with, so everything runs.
    process.stderr.write(
      `no diff against ${base} (${error.message.split('\n')[0]}): all affected\n`,
    );
    return null;
  }
}

function main() {
  const base = process.argv[2] ?? '';
  const changed = changedSince(base);
  const all = changed === null || forcesAll(changed);
  const packages = turboPackages(all ? '' : `...[${base}]`);
  const hasJest = (dir) =>
    existsSync(join(root, dir, 'jest.config.js')) ||
    existsSync(join(root, dir, 'jest.integration.config.js'));
  const outputs = summarise(packages, { all, base, hasJest });

  process.stderr.write(
    `${all ? 'all' : String(packages.length)} packages affected; jest workspaces: ${outputs.workspaces || 'none'}\n`,
  );
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value)}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  else process.stdout.write(`${lines.join('\n')}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
