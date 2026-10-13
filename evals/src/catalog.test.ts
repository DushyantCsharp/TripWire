import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';
import { FAULT_CLASSES } from '@tripwire/agent';
import { hashEmbedding, parseRunbook, sectionText } from '@tripwire/pipeline';
import { listCases, readCase, writeCase } from './cases.js';
import { CATALOG, FAULTS, INJECTIONS, RESERVE, SUBSETS } from './catalog.js';
import { syntheticChanges } from './changes.js';
import { fixtureCase } from './testing/fixtures.js';

/** Every flag in the demo's flagd configuration (3.1.0, src/flagd/demo.flagd.json). */
const DEMO_FLAGS = [
  'adFailure',
  'adHighCpu',
  'adManualGc',
  'aiRunawayAgent',
  'aiSlowResponse',
  'cartFailure',
  'emailMemoryLeak',
  'emitRawPii',
  'failedReadinessProbe',
  'imageSlowLoad',
  'intlShippingSlowdown',
  'kafkaQueueProblems',
  'loadGeneratorFloodHomepage',
  'paymentFailure',
  'paymentUnreachable',
  'productCatalogFailure',
  'productCatalogLockContention',
  'recommendationCacheFailure',
];

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

describe('the golden-set catalog', () => {
  it('has 40 golden cases and 5 storms, with unique ids, from real demo flags', () => {
    expect(CATALOG.filter((s) => s.kind === 'golden')).toHaveLength(40);
    expect(CATALOG.filter((s) => s.kind === 'storm')).toHaveLength(5);
    const ids = [...CATALOG, ...RESERVE, ...INJECTIONS].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of [...CATALOG, ...RESERVE]) expect(DEMO_FLAGS).toContain(spec.flag);
    for (const fault of Object.values(FAULTS))
      expect(FAULT_CLASSES).toContain(fault.groundTruth.faultClass);
  });

  it('builds every injection case on a case it captures', () => {
    const captured = new Set(CATALOG.map((s) => s.id));
    for (const injection of INJECTIONS) expect(captured).toContain(injection.baseCase);
  });

  it('names only real cases in its subsets, and the nightly one covers every fault class', () => {
    const ids = new Set([...CATALOG, ...INJECTIONS].map((s) => s.id));
    for (const subset of Object.values(SUBSETS)) for (const id of subset) expect(ids).toContain(id);
    const nightly = new Set(SUBSETS.nightly);
    const golden = CATALOG.filter((s) => s.kind === 'golden');
    const classesIn = (specs: typeof CATALOG) =>
      new Set(specs.map((s) => FAULTS[s.flag]?.groundTruth.faultClass));
    expect(classesIn(golden.filter((s) => nightly.has(s.id)))).toEqual(classesIn(golden));
    expect(CATALOG.filter((s) => s.kind === 'storm' && nightly.has(s.id))).toHaveLength(2);
    expect(INJECTIONS.filter((s) => nightly.has(s.id))).toHaveLength(2);
  });

  it('gives about half the cases a change hint', () => {
    const hinted = CATALOG.filter((s) => s.changeHint).length;
    expect(Math.abs(hinted - CATALOG.length / 2)).toBeLessThanOrEqual(1);
  });
});

describe('leakage', () => {
  // The answer must come from telemetry: nothing the agent reads may name the fault's flag.
  const flagPattern = new RegExp(`\\b(${DEMO_FLAGS.join('|')})\\b`, 'i');

  it.each([
    ...readdirSync(root('runbooks')).map((file) => [
      `runbooks/${file}`,
      readFileSync(root(`runbooks/${file}`), 'utf8'),
    ]),
    ['evals/alert-rules.yaml', readFileSync(root('evals/alert-rules.yaml'), 'utf8')],
    ...INJECTIONS.map((spec) => [`injection ${spec.id}`, spec.text]),
  ])('%s names no fault flag', (_name, text) => {
    expect(text.match(flagPattern)?.[0]).toBeUndefined();
  });

  it('keeps flags out of synthetic changes', () => {
    for (const spec of CATALOG) {
      const fault = FAULTS[spec.flag];
      if (!fault) throw new Error(spec.flag);
      const changes = syntheticChanges(spec.id, {
        exclude: [fault.groundTruth.service, ...(fault.groundTruth.aliases ?? [])],
        configuredIn: fault.configuredIn,
        flippedAt: new Date('2026-10-01T12:00:00Z'),
        hint: spec.changeHint,
      });
      for (const change of changes) expect(change.description).not.toMatch(flagPattern);
    }
  });
});

describe('runbook retrieval', () => {
  const sections = readdirSync(root('runbooks')).flatMap((file) =>
    parseRunbook(file, readFileSync(root(`runbooks/${file}`), 'utf8')),
  );
  const vectors = sections.map((section) => hashEmbedding(sectionText(section)));
  const cosine = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

  // What the agent would ask: the service and the kind of trouble. The service's runbook (or an
  // alias's) must be in the top two: get_runbook returns two sections by default.
  it.each(Object.values(FAULTS).map((fault) => [fault.flag, fault] as const))(
    'finds the runbook for %s',
    (_flag, fault) => {
      const { service, faultClass, aliases = [] } = fault.groundTruth;
      const query = hashEmbedding(`${service} ${faultClass.replace(/_/g, ' ')}`);
      const ranked = sections
        .map((section, i) => ({ section, score: cosine(query, vectors[i] ?? []) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);
      const wanted = new Set([service, ...aliases]);
      expect(
        ranked.some(({ section }) => section.service !== null && wanted.has(section.service)),
      ).toBe(true);
    },
  );
});

describe('case files', () => {
  it('round-trip through disk, gzipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-golden-'));
    try {
      const data = fixtureCase();
      writeCase(dir, data);
      expect(listCases(dir)).toEqual([data.meta.id]);
      expect(readCase(join(dir, data.meta.id))).toEqual(data);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
