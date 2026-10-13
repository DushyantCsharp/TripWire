// The adjusted Rand index (Hubert and Arabie, 1985): how well a clustering (incidents) agrees with
// the truth (the problems that raised the alerts), corrected for chance. 1 is perfect, about 0 is
// what chance gives, and it can go negative. The brief's dedupe target is 0.9 or more.

const pairs = (n: number) => (n * (n - 1)) / 2;

function counts(keys: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const key of keys) out.set(key, (out.get(key) ?? 0) + 1);
  return out;
}

const sumPairs = (values: Iterable<number>) => [...values].reduce((sum, n) => sum + pairs(n), 0);

/** Null with fewer than two items: no pair to agree or disagree on. */
export function adjustedRandIndex(
  items: readonly { readonly truth: string; readonly cluster: string }[],
): number | null {
  if (items.length < 2) return null;
  const together = sumPairs(
    counts(items.map((item) => `${item.truth}\u0000${item.cluster}`)).values(),
  );
  const truths = sumPairs(counts(items.map((item) => item.truth)).values());
  const clusters = sumPairs(counts(items.map((item) => item.cluster)).values());
  const expected = (truths * clusters) / pairs(items.length);
  const best = (truths + clusters) / 2;
  // Both partitions trivial (everything apart, or everything together): they agree exactly.
  if (best === expected) return 1;
  return (together - expected) / (best - expected);
}
