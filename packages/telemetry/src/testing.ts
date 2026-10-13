// A meter that keeps what it records in memory, for tests in any workspace:
// `@tripwire/telemetry/testing`. Never shipped in dist/.
import type { Attributes, Meter } from '@opentelemetry/api';
import { DataPointType, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';

class CollectingReader extends MetricReader {
  protected override onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected override onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface Point {
  readonly name: string;
  readonly attributes: Attributes;
  /** A counter's or gauge's value; a histogram's count, sum and bucket counts. */
  readonly value: number | { count: number; sum: number; buckets: readonly number[] };
}

export interface TestMeter {
  readonly meter: Meter;
  /** Everything recorded so far, one point per metric and attribute set. */
  read(): Promise<Point[]>;
}

export function testMeter(): TestMeter {
  const reader = new CollectingReader();
  const provider = new MeterProvider({ readers: [reader] });
  return {
    meter: provider.getMeter('test'),
    async read() {
      const { resourceMetrics, errors } = await reader.collect();
      if (errors.length > 0) throw new Error(`collecting metrics failed: ${String(errors[0])}`);
      return resourceMetrics.scopeMetrics.flatMap((scope) =>
        scope.metrics.flatMap((metric) =>
          metric.dataPoints.map((point): Point => {
            const value = point.value;
            return {
              name: metric.descriptor.name,
              attributes: point.attributes,
              value:
                metric.dataPointType === DataPointType.HISTOGRAM && typeof value === 'object'
                  ? {
                      count: value.count,
                      sum: value.sum ?? 0,
                      buckets: 'buckets' in value ? value.buckets.counts : [],
                    }
                  : (value as number),
            };
          }),
        ),
      );
    },
  };
}
