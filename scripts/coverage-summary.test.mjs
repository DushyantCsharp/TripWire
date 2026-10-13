import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { byWorkspace, renderSummary, workspaceOf } from './coverage-summary.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const file = (path) => join(root, path);
const metrics = (covered, total) => ({
  lines: { covered, total },
  branches: { covered: 1, total: 2 },
  functions: { covered: 1, total: 1 },
});

describe('coverage summary', () => {
  it('files coverage under its workspace', () => {
    assert.equal(workspaceOf(file('packages/db/src/schema.ts')), 'packages/db');
    assert.equal(workspaceOf(file('apps/worker/src/triage/processor.ts')), 'apps/worker');
    assert.equal(workspaceOf(file('evals/src/replay/incident.ts')), 'evals');
  });

  it('sums each workspace and marks the gated ones', () => {
    const summary = {
      total: metrics(0, 0),
      [file('packages/db/src/a.ts')]: metrics(8, 10),
      [file('packages/db/src/b.ts')]: metrics(1, 10),
      [file('apps/api/src/server.ts')]: metrics(3, 4),
    };
    assert.deepEqual(
      byWorkspace(summary).map(([workspace, sums]) => [workspace, sums.lines]),
      [
        ['apps/api', [3, 4]],
        ['packages/db', [9, 20]],
      ],
    );
    const markdown = renderSummary(summary);
    assert.match(
      markdown,
      /\| packages\/db \(gate: lines ≥ 80%\) \| 45\.0% \| 50\.0% \| 100\.0% \|/,
    );
    assert.match(markdown, /\| apps\/api \| 75\.0% \|/);
  });
});
