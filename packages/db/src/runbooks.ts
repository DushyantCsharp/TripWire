import { asc, cosineDistance, eq, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { dbCall } from './errors.js';
import { runbookChunks } from './schema.js';

export interface RunbookChunk {
  readonly path: string;
  readonly anchor: string;
  readonly title: string;
  readonly service: string | null;
  readonly content: string;
  /** Hex SHA-256 of the section's text and title. */
  readonly contentHash: string;
  readonly embedder: string;
  readonly embedding: readonly number[];
}

/**
 * Makes runbook_chunks hold exactly `chunks`, in one transaction: new and changed sections are
 * written, unchanged ones left alone, and sections no longer in the files deleted.
 */
export function syncRunbookChunks(db: Database, chunks: readonly RunbookChunk[]) {
  return dbCall(() =>
    db.transaction(async (tx) => {
      let written = 0;
      for (const chunk of chunks) {
        const values = { ...chunk, embedding: [...chunk.embedding] };
        const rows = await tx
          .insert(runbookChunks)
          .values(values)
          .onConflictDoUpdate({
            target: [runbookChunks.path, runbookChunks.anchor],
            set: values,
            // Only when it changed: unchanged sections keep their row and updated_at.
            setWhere: sql`${runbookChunks.contentHash} <> excluded.content_hash
              OR ${runbookChunks.embedder} <> excluded.embedder`,
          })
          .returning({ id: runbookChunks.id });
        written += rows.length;
      }
      const keys = chunks.map((chunk) => `${chunk.path}#${chunk.anchor}`);
      const deleted = await tx
        .delete(runbookChunks)
        .where(notInArray(sql`${runbookChunks.path} || '#' || ${runbookChunks.anchor}`, keys))
        .returning({ id: runbookChunks.id });
      return { written, deleted: deleted.length };
    }),
  );
}

export interface RunbookSearch {
  /** Only this service's runbooks, plus the general ones that name no service. */
  readonly service?: string | undefined;
  readonly k: number;
}

/** The k sections nearest an embedding, by cosine distance. Exported so tests can EXPLAIN it. */
export function searchRunbooksQuery(
  db: Database,
  embedding: readonly number[],
  { service, k }: RunbookSearch,
) {
  const distance = cosineDistance(runbookChunks.embedding, [...embedding]);
  return db
    .select({
      path: runbookChunks.path,
      anchor: runbookChunks.anchor,
      title: runbookChunks.title,
      service: runbookChunks.service,
      content: runbookChunks.content,
      distance,
    })
    .from(runbookChunks)
    .where(
      service === undefined
        ? undefined
        : or(eq(runbookChunks.service, service), isNull(runbookChunks.service)),
    )
    .orderBy(distance, asc(runbookChunks.path), asc(runbookChunks.anchor))
    .limit(k);
}

export interface RunbookMatch {
  readonly path: string;
  readonly anchor: string;
  readonly title: string;
  readonly service: string | null;
  readonly content: string;
  /** Cosine similarity, 1 − distance. */
  readonly score: number;
}

export function searchRunbooks(db: Database, embedding: readonly number[], search: RunbookSearch) {
  return dbCall(async () => {
    const rows = await searchRunbooksQuery(db, embedding, search);
    return rows.map(({ distance, ...row }): RunbookMatch => ({
      ...row,
      score: 1 - Number(distance),
    }));
  });
}

/** How many sections are indexed, by embedder: an empty index means `just runbooks-index`. */
export function runbookIndexSize(db: Database) {
  return dbCall(async () => {
    const rows = await db
      .select({ embedder: runbookChunks.embedder, count: sql<number>`count(*)::int` })
      .from(runbookChunks)
      .groupBy(runbookChunks.embedder);
    return rows;
  });
}
