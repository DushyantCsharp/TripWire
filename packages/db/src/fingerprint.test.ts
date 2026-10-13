import { describe, expect, it } from '@jest/globals';
import { fingerprintV1, fingerprintV2, VOLATILE_LABELS, type Labels } from './fingerprint.js';

const identity = { alertname: 'HighErrorRate', service: 'checkout', namespace: 'otel-demo' };
const onPod = { ...identity, severity: 'critical', pod: 'checkout-7d9f8-abcde' };

describe('fingerprints', () => {
  // Stored values, written by ingest and the backfill alike: changing the hash would split every
  // open incident from its next alert. Change these only together with a migration.
  it.each([
    [
      'v1',
      fingerprintV1,
      onPod,
      '1555f4e2b6779735d2a6a4c2469340116d09f0a1545b2056f803e5e415f02687',
    ],
    [
      'v2',
      fingerprintV2,
      onPod,
      'b793877f4870720e1166b0ab7b5e8b24e24353800d840dbc6dd3939431006568',
    ],
    ['v2', fingerprintV2, {}, '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'],
  ])('%s of %j is pinned', (_version, fingerprint, labels, digest) => {
    expect(fingerprint(labels)).toBe(digest);
  });

  // [case, a, b, v1 equal, v2 equal]
  it.each<[string, Labels, Labels, boolean, boolean]>([
    ['the same labels', identity, { ...identity }, true, true],
    [
      'labels in another order',
      identity,
      { namespace: 'otel-demo', service: 'checkout', alertname: 'HighErrorRate' },
      true,
      true,
    ],
    ['another pod', { ...identity, pod: 'a' }, { ...identity, pod: 'b' }, false, true],
    [
      'another instance and ip',
      { ...identity, instance: '10.0.0.1:5050', ip: '10.0.0.1' },
      { ...identity, instance: '10.0.0.2:5050', ip: '10.0.0.2' },
      false,
      true,
    ],
    [
      'an escalated severity',
      { ...identity, severity: 'warning' },
      { ...identity, severity: 'critical' },
      false,
      true,
    ],
    [
      'a volatile label only one side has',
      identity,
      { ...identity, hostname: 'node-3' },
      false,
      true,
    ],
    ['another alertname', identity, { ...identity, alertname: 'HighLatencyP99' }, false, false],
    ['another service', identity, { ...identity, service: 'payment' }, false, false],
    ['another namespace', identity, { ...identity, namespace: 'staging' }, false, false],
    ['an extra identity label', identity, { ...identity, route: '/api/checkout' }, false, false],
    ['a label value moved to another name', { a: 'x', b: '' }, { a: '', b: 'x' }, false, false],
  ])('%s: v1 equal %p, v2 equal %p', (_case, a, b, v1Equal, v2Equal) => {
    expect(fingerprintV1(a) === fingerprintV1(b)).toBe(v1Equal);
    expect(fingerprintV2(a) === fingerprintV2(b)).toBe(v2Equal);
  });

  it.each([...VOLATILE_LABELS])('v2 ignores %s', (label) => {
    expect(fingerprintV2({ ...identity, [label]: 'anything' })).toBe(fingerprintV2(identity));
  });

  it('is a SHA-256 hex digest', () => {
    expect(fingerprintV2(identity)).toMatch(/^[0-9a-f]{64}$/);
  });
});
