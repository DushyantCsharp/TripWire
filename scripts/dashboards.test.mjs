// The Grafana dashboards and alert rules (infra/grafana/provisioning) query only metrics the code
// defines, under the names Prometheus gives them, and only datasources that are provisioned.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..');
const provisioning = join(root, 'infra/grafana/provisioning');
const read = (path) => readFileSync(join(root, path), 'utf8');

/**
 * Prometheus names for the instruments in the apps' telemetry.ts, as its OTLP translation writes
 * them: a unit suffix from `s` (braced units add none), `_total` on counters, and the histogram
 * series.
 */
function definedMetrics() {
  const names = new Set();
  for (const file of ['apps/api/src/telemetry.ts', 'apps/worker/src/telemetry.ts']) {
    const source = read(file);
    for (const [, kind, name, unit] of source.matchAll(
      /create(Histogram|Counter|ObservableGauge)\(\s*'([a-z_]+)',\s*\{\s*unit:\s*'([^']+)'/g,
    )) {
      const base = unit === 's' ? `${name}_seconds` : name;
      if (kind === 'Histogram')
        for (const s of ['bucket', 'count', 'sum']) names.add(`${base}_${s}`);
      else if (kind === 'Counter') names.add(base.endsWith('_total') ? base : `${base}_total`);
      else names.add(base);
    }
  }
  return names;
}

const PROMQL_WORDS = new Set([
  'sum',
  'max',
  'min',
  'avg',
  'by',
  'without',
  'rate',
  'increase',
  'delta',
  'deriv',
  'histogram_quantile',
  'le',
  'and',
  'or',
  'unless',
  'offset',
]);

/** The metric names a PromQL expression reads (identifiers before `{`, `[` or `)`), not labels. */
function metricsIn(expr) {
  const withoutStrings = expr
    .replace(/"[^"]*"/g, '""')
    .replace(/\{[^}]*\}/g, '{}')
    // Label lists: by (status), without (pod).
    .replace(/\b(by|without)\s*\([^)]*\)/g, '');
  const words = withoutStrings.match(/[a-z_][a-z0-9_]*(?=\s*[{[)])/g) ?? [];
  return words.filter((word) => !PROMQL_WORDS.has(word) && !word.startsWith('__'));
}

function dashboards() {
  const dir = join(provisioning, 'dashboards/json');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ file, dashboard: JSON.parse(readFileSync(join(dir, file), 'utf8')) }));
}

const panels = (dashboard) =>
  dashboard.panels
    .flatMap((panel) => [panel, ...(panel.panels ?? [])])
    .filter((p) => p.type !== 'row');

describe('Grafana provisioning', () => {
  const defined = definedMetrics();
  const datasources = new Set(
    [
      ...read('infra/grafana/provisioning/datasources/datasources.yaml').matchAll(/uid:\s*(\S+)/g),
    ].map((m) => m[1]),
  );

  it('reads the instruments it checks against', () => {
    for (const name of [
      'ingest_ack_latency_seconds_bucket',
      'shed_requests_total',
      'queue_depth',
      'dlq_size',
      'triage_duration_seconds_count',
      'tokens_total',
      'cost_usd_total',
    ]) {
      assert.ok(defined.has(name), `${name} not found in the apps' telemetry.ts`);
    }
  });

  for (const { file, dashboard } of dashboards()) {
    it(`${file}: every panel queries a provisioned datasource and defined metrics`, () => {
      assert.ok(dashboard.uid && dashboard.title, 'a dashboard needs a uid and a title');
      const ids = panels(dashboard).map((p) => p.id);
      assert.equal(new Set(ids).size, ids.length, 'panel ids repeat');
      for (const panel of panels(dashboard)) {
        assert.ok(
          datasources.has(panel.datasource.uid),
          `${panel.title}: datasource ${panel.datasource.uid}`,
        );
        for (const target of panel.targets ?? []) {
          if (!target.expr) continue;
          for (const metric of metricsIn(target.expr)) {
            assert.ok(
              defined.has(metric),
              `${panel.title}: ${metric} isn't a metric the code defines`,
            );
          }
        }
      }
    });
  }

  it('alert rules query defined metrics, each with a threshold step', () => {
    const rules = read('infra/grafana/provisioning/alerting/rules.yaml');
    const exprs = [...rules.matchAll(/^\s+expr:\s*(.+)$/gm)].map((m) => m[1]);
    assert.equal(exprs.length, 2);
    for (const expr of exprs) {
      for (const metric of metricsIn(expr)) assert.ok(defined.has(metric), `${metric} in ${expr}`);
    }
    assert.equal([...rules.matchAll(/type:\s*threshold/g)].length, 2);
    assert.equal([...rules.matchAll(/datasourceUid:\s*prometheus/g)].length, 2);
  });
});
