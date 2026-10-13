import { describe, expect, it } from '@jest/globals';
import { decideCluster, dedupeWindowStart, type DedupeCandidates } from './dedupe.js';
import type { IncidentStatus } from './incidents.js';

const WINDOW_MS = 10 * 60_000;
const options = { windowMs: WINDOW_MS, similarityThreshold: 0.85 };
const receivedAt = new Date('2026-10-01T12:00:00Z');
/** `ms` before the alert arrived; negative is after it (alerts cluster out of order). */
const before = (ms: number) => new Date(receivedAt.getTime() - ms);

const fingerprintMatch = (ms: number, incidentStatus: IncidentStatus = 'open') => ({
  incidentId: 'inc-fingerprint',
  incidentStatus,
  receivedAt: before(ms),
});
const nearest = (similarity: number, ms = 0, incidentStatus: IncidentStatus = 'triaging') => ({
  incidentId: 'inc-similar',
  incidentStatus,
  lastSeen: before(ms),
  similarity,
});

describe('dedupe window', () => {
  it('starts exactly the window before the alert', () => {
    expect(dedupeWindowStart(receivedAt, WINDOW_MS)).toEqual(new Date('2026-10-01T11:50:00Z'));
  });

  it.each<[string, DedupeCandidates, string]>([
    // Same fingerprint, by age of the newest matching alert.
    ['a same-fingerprint alert just now', { sameFingerprint: fingerprintMatch(0) }, 'fingerprint'],
    [
      'one that arrived after this alert',
      { sameFingerprint: fingerprintMatch(-30_000) },
      'fingerprint',
    ],
    [
      'one a millisecond inside the window',
      { sameFingerprint: fingerprintMatch(WINDOW_MS - 1) },
      'fingerprint',
    ],
    [
      'one exactly at the window start',
      { sameFingerprint: fingerprintMatch(WINDOW_MS) },
      'fingerprint',
    ],
    [
      'one a millisecond outside the window',
      { sameFingerprint: fingerprintMatch(WINDOW_MS + 1) },
      'new_incident',
    ],
    [
      'one in a resolved incident',
      { sameFingerprint: fingerprintMatch(0, 'resolved') },
      'new_incident',
    ],
    [
      'one in a triaged incident',
      { sameFingerprint: fingerprintMatch(0, 'triaged') },
      'fingerprint',
    ],
    // Embedding similarity, when no fingerprint matches.
    ['a very similar active incident', { nearest: nearest(0.97) }, 'embedding'],
    ['similarity just over the threshold', { nearest: nearest(0.850_001) }, 'embedding'],
    ['similarity exactly at the threshold', { nearest: nearest(0.85) }, 'new_incident'],
    ['similarity under the threshold', { nearest: nearest(0.6) }, 'new_incident'],
    [
      'a similar incident last active at the window start',
      { nearest: nearest(0.97, WINDOW_MS) },
      'embedding',
    ],
    [
      'a similar incident gone quiet past the window',
      { nearest: nearest(0.97, WINDOW_MS + 1) },
      'new_incident',
    ],
    ['a similar but resolved incident', { nearest: nearest(0.97, 0, 'resolved') }, 'new_incident'],
    // Precedence.
    [
      'both: fingerprint wins over a closer embedding',
      { sameFingerprint: fingerprintMatch(60_000), nearest: nearest(1) },
      'fingerprint',
    ],
    [
      'a stale fingerprint falls through to embedding',
      { sameFingerprint: fingerprintMatch(WINDOW_MS + 1), nearest: nearest(0.9) },
      'embedding',
    ],
    ['nothing at all', {}, 'new_incident'],
  ])('%s → %s', (_case, candidates, match) => {
    expect(decideCluster(receivedAt, candidates, options).match).toBe(match);
  });

  it('names the incident it attaches to, and the similarity that justified it', () => {
    expect(decideCluster(receivedAt, { sameFingerprint: fingerprintMatch(0) }, options)).toEqual({
      match: 'fingerprint',
      incidentId: 'inc-fingerprint',
    });
    expect(decideCluster(receivedAt, { nearest: nearest(0.91) }, options)).toEqual({
      match: 'embedding',
      incidentId: 'inc-similar',
      similarity: 0.91,
    });
  });

  it('follows the configured window and threshold', () => {
    const candidates = { sameFingerprint: fingerprintMatch(3 * 60_000), nearest: nearest(0.8) };
    expect(
      decideCluster(receivedAt, candidates, { windowMs: 60_000, similarityThreshold: 0.85 }).match,
    ).toBe('new_incident');
    expect(
      decideCluster(receivedAt, candidates, { windowMs: 60_000, similarityThreshold: 0.75 }).match,
    ).toBe('embedding');
  });
});
