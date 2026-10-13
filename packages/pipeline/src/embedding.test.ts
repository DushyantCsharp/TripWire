import { describe, expect, it } from '@jest/globals';
import { alertText } from './alerts.js';
import { EMBEDDING_DIMENSIONS, hashEmbedding } from './embedding.js';

const cosine = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

const alert = (name: string, service: string, pod: string) =>
  alertText({
    name,
    service,
    summary: `${service}: ${name}`,
    labels: { alertname: name, service, namespace: 'otel-demo', pod, severity: 'critical' },
  });

describe('hashing embedder', () => {
  it('produces deterministic 1024-dimension unit vectors', () => {
    const vector = hashEmbedding(alert('HighErrorRate', 'checkout', 'p1'));
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(cosine(vector, vector)).toBeCloseTo(1, 10);
    expect(hashEmbedding(alert('HighErrorRate', 'checkout', 'p1'))).toEqual(vector);
  });

  it('embeds every replica of the same alert identically', () => {
    expect(hashEmbedding(alert('HighErrorRate', 'checkout', 'p1'))).toEqual(
      hashEmbedding(alert('HighErrorRate', 'checkout', 'p2')),
    );
  });

  it('puts related alerts closer than unrelated ones', () => {
    const errors = hashEmbedding(alert('HighErrorRate', 'checkout', 'p1'));
    const latency = hashEmbedding(alert('HighLatencyP99', 'checkout', 'p1'));
    const kafka = hashEmbedding(alert('KafkaConsumerLag', 'accounting', 'p1'));
    expect(cosine(errors, latency)).toBeGreaterThan(cosine(errors, kafka));
  });

  it('gives empty text a valid unit vector', () => {
    expect(cosine(hashEmbedding(''), hashEmbedding(''))).toBe(1);
  });
});
