import { createHash } from 'node:crypto';
import { ok, type Result } from '@tripwire/result';

/** Matches incidents.embedding (vector(1024)). */
export const EMBEDDING_DIMENSIONS = 1024;

export interface EmbeddingError {
  readonly kind: 'upstream_unavailable';
  readonly message: string;
}

export interface Embedder {
  readonly name: string;
  embed(text: string): Promise<Result<number[], EmbeddingError>>;
}

/**
 * Feature hashing: every word adds ±1 to one of 1,024 buckets, and the vector is L2-normalised.
 * Alerts that share words (alert name, service, summary) point the same way. It is deterministic,
 * local and free; a learned embedding model can replace it behind the same interface.
 */
export function hashingEmbedder(): Embedder {
  return {
    name: 'feature-hashing-v1',
    embed: (text) => Promise.resolve(ok(hashEmbedding(text))),
  };
}

export function hashEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const token of tokenize(text)) {
    const digest = createHash('md5').update(token).digest();
    const bucket = digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
    vector[bucket] = (vector[bucket] ?? 0) + ((digest[4] ?? 0) & 1 ? 1 : -1);
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  // An empty text still gets a valid unit vector: pgvector's cosine distance is NaN for zeros.
  if (norm === 0) return vector.map((_, i) => (i === 0 ? 1 : 0));
  return vector.map((x) => x / norm);
}

/** Lower-case words, with camelCase split apart: "HighErrorRate" shares "error" with others. */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}
