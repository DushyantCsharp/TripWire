import { ok, type Result } from '@tripwire/result';
import { and, cosineDistance, desc, inArray, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { dbCall, type DatabaseError } from './errors.js';
import { incidents, type incidentStatus } from './schema.js';

export type IncidentStatus = (typeof incidentStatus.enumValues)[number];

/** Position after the last incident of a page. The API encodes it as an opaque cursor. */
export interface IncidentCursor {
  readonly lastSeen: Date;
  readonly id: string;
}

export interface ListIncidentsArgs {
  readonly limit: number;
  readonly after?: IncidentCursor | undefined;
  readonly status?: readonly IncidentStatus[] | undefined;
}

const incidentSummary = {
  id: incidents.id,
  title: incidents.title,
  status: incidents.status,
  severity: incidents.severity,
  service: incidents.service,
  alertCount: incidents.alertCount,
  firstSeen: incidents.firstSeen,
  lastSeen: incidents.lastSeen,
};

/** Keyset pagination on (last_seen DESC, id DESC). Fetches one extra row to detect a next page. */
export function listIncidentsQuery(db: Database, args: ListIncidentsArgs) {
  return db
    .select(incidentSummary)
    .from(incidents)
    .where(
      and(
        args.after &&
          sql`(${incidents.lastSeen}, ${incidents.id}) < (${args.after.lastSeen}, ${args.after.id})`,
        args.status?.length ? inArray(incidents.status, [...args.status]) : undefined,
      ),
    )
    .orderBy(desc(incidents.lastSeen), desc(incidents.id))
    .limit(args.limit + 1);
}

export type IncidentSummary = Awaited<ReturnType<typeof listIncidentsQuery>>[number];

export interface IncidentPage {
  readonly items: readonly IncidentSummary[];
  readonly next: IncidentCursor | null;
}

export async function listIncidents(
  db: Database,
  args: ListIncidentsArgs,
): Promise<Result<IncidentPage, DatabaseError>> {
  const rows = await dbCall(() => listIncidentsQuery(db, args));
  if (!rows.ok) return rows;
  const items = rows.value.slice(0, args.limit);
  const last = items.at(-1);
  const next =
    rows.value.length > args.limit && last ? { lastSeen: last.lastSeen, id: last.id } : null;
  return ok({ items, next });
}

/** Nearest incidents by cosine distance, served by the HNSW index. */
export function similarIncidentsQuery(db: Database, embedding: readonly number[], limit: number) {
  const distance = cosineDistance(incidents.embedding, [...embedding]);
  return db
    .select({
      id: incidents.id,
      title: incidents.title,
      service: incidents.service,
      distance: distance.mapWith(Number),
    })
    .from(incidents)
    .orderBy(distance)
    .limit(limit);
}

export function findSimilarIncidents(db: Database, embedding: readonly number[], limit: number) {
  return dbCall(() => similarIncidentsQuery(db, embedding, limit));
}
