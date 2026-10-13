import { createHash } from 'node:crypto';
import type { Change } from '@tripwire/agent';

// The demo has no deploy system, so list_deploys gets synthetic changes: 0–3 decoy deploys of
// services the fault didn't touch, from the hours before it, and for about half the cases a
// generic note that the faulty service's feature-flag configuration changed when the fault began.
// The note never names the flag. Both are deterministic for a case id and marked synthetic.

export const DEMO_SERVICES = [
  'accounting',
  'ad',
  'cart',
  'checkout',
  'currency',
  'email',
  'fraud-detection',
  'frontend',
  'frontend-proxy',
  'image-provider',
  'payment',
  'product-catalog',
  'quote',
  'recommendation',
  'shipping',
] as const;

export interface ChangeOptions {
  /** Services the decoys must not touch: the ground truth and everything named with it. */
  readonly exclude: readonly string[];
  /** The service whose configuration the fault's flag changes. */
  readonly configuredIn: string;
  readonly flippedAt: Date;
  readonly hint: boolean;
}

export function syntheticChanges(caseId: string, options: ChangeOptions): Change[] {
  const random = seeded(caseId);
  const candidates = DEMO_SERVICES.filter(
    (service) => !options.exclude.includes(service) && service !== options.configuredIn,
  );
  const decoys: Change[] = [];
  const count = Math.floor(random() * 4);
  for (let i = 0; i < count && candidates.length > 0; i++) {
    const [service] = candidates.splice(Math.floor(random() * candidates.length), 1);
    if (service === undefined) break;
    const version = `${String(1 + Math.floor(random() * 3))}.${String(Math.floor(random() * 20))}.${String(Math.floor(random() * 10))}`;
    const minutesBefore = 10 + Math.floor(random() * 350);
    decoys.push({
      id: `deploy-${service}-${version}`,
      service,
      kind: 'deploy',
      description: `${service} ${version} rolled out`,
      at: new Date(options.flippedAt.getTime() - minutesBefore * 60_000),
    });
  }
  if (!options.hint) return decoys;
  return [
    ...decoys,
    {
      id: `config-${options.configuredIn}-${options.flippedAt.toISOString().replace(/[:.]/g, '')}`,
      service: options.configuredIn,
      kind: 'config',
      description: `${options.configuredIn}: feature flag configuration updated`,
      at: options.flippedAt,
    },
  ];
}

/** A deterministic random source for a seed string (mulberry32 over the seed's hash). */
export function seeded(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32BE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
