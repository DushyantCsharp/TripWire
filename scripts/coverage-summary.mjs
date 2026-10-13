// Coverage per workspace as a markdown table, for CI's job summary:
//   node scripts/coverage-summary.mjs coverage/coverage-summary.json >> "$GITHUB_STEP_SUMMARY"
// Reads Jest's json-summary report; the gated workspaces are marked with their threshold.
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const GATED = { 'packages/agent': 80, 'packages/db': 80 };
const METRICS = ['lines', 'branches', 'functions'];

/** The workspace a covered file belongs to: `apps/x`, `packages/x` or `evals`. */
export function workspaceOf(file) {
  const parts = relative(root, file).split('/');
  return parts[0] === 'evals' ? 'evals' : parts.slice(0, 2).join('/');
}

/** Totals per workspace from a json-summary report (keys are absolute file paths, plus `total`). */
export function byWorkspace(summary) {
  const totals = new Map();
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === 'total') continue;
    const workspace = workspaceOf(file);
    const sums = totals.get(workspace) ?? Object.fromEntries(METRICS.map((m) => [m, [0, 0]]));
    for (const metric of METRICS) {
      sums[metric][0] += metrics[metric].covered;
      sums[metric][1] += metrics[metric].total;
    }
    totals.set(workspace, sums);
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const pct = ([covered, total]) => (total === 0 ? '–' : `${((100 * covered) / total).toFixed(1)}%`);

export function renderSummary(summary) {
  const rows = byWorkspace(summary).map(([workspace, sums]) => {
    const gate = GATED[workspace] ? ` (gate: lines ≥ ${String(GATED[workspace])}%)` : '';
    return `| ${workspace}${gate} | ${METRICS.map((m) => pct(sums[m])).join(' | ')} |`;
  });
  return [
    '### Coverage',
    '',
    '| Workspace | Lines | Branches | Functions |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

function main() {
  const file = process.argv[2] ?? 'coverage/coverage-summary.json';
  if (!existsSync(file)) {
    process.stdout.write(
      '### Coverage\n\nNo coverage report: the run stopped before writing one.\n',
    );
    return;
  }
  process.stdout.write(renderSummary(JSON.parse(readFileSync(file, 'utf8'))));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
