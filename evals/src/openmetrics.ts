import type { RawSeries } from './cases.js';

// Captured Prometheus samples as OpenMetrics text, for `promtool tsdb create-blocks-from
// openmetrics`, which turns them back into a TSDB a real Prometheus can answer PromQL from. Every
// family is typed `unknown`: the TSDB doesn't keep types, and `counter` would demand names without
// _total. Families are contiguous, samples ascend in time, timestamps are seconds.

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface OpenMetrics {
  readonly text: string;
  readonly series: number;
  readonly samples: number;
  /** Series dropped because a name can't be written unquoted. */
  readonly skipped: number;
}

export function toOpenMetrics(series: readonly RawSeries[]): OpenMetrics {
  const families = new Map<string, { labels: [string, string][]; samples: [number, string][] }[]>();
  let skipped = 0;
  for (const { labels, samples } of series) {
    const name = labels.__name__;
    const rest = Object.entries(labels).filter(([label]) => label !== '__name__');
    if (name === undefined || !NAME.test(name) || !rest.every(([label]) => LABEL.test(label))) {
      skipped += 1;
      continue;
    }
    rest.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    families.set(name, [...(families.get(name) ?? []), { labels: rest, samples: [...samples] }]);
  }

  const lines: string[] = [];
  let count = 0;
  let written = 0;
  for (const name of [...families.keys()].sort()) {
    lines.push(`# TYPE ${name} unknown`);
    const members = families.get(name) ?? [];
    members.sort((a, b) => labelText(a.labels).localeCompare(labelText(b.labels)));
    for (const member of members) {
      written += 1;
      const labels = labelText(member.labels);
      for (const [at, value] of member.samples.sort(([a], [b]) => a - b)) {
        lines.push(`${name}${labels} ${value} ${String(at)}`);
        count += 1;
      }
    }
  }
  lines.push('# EOF');
  return { text: `${lines.join('\n')}\n`, series: written, samples: count, skipped };
}

function labelText(labels: readonly [string, string][]): string {
  if (labels.length === 0) return '';
  return `{${labels.map(([name, value]) => `${name}="${escape(value)}"`).join(',')}}`;
}

function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
