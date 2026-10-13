import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { RunbookIndex } from '@tripwire/agent';
import { type Database, type DatabaseError, searchRunbooks, syncRunbookChunks } from '@tripwire/db';
import { attempt, err, ok, type Result } from '@tripwire/result';
import type { Embedder, EmbeddingError } from './embedding.js';

// The runbooks in /runbooks, as get_runbook searches them: each file's `##` sections, embedded
// and stored in Postgres (runbook_chunks), searched by cosine similarity with pgvector.

export interface RunbookSectionText {
  /** Relative to the runbooks directory. */
  readonly path: string;
  readonly anchor: string;
  readonly title: string;
  readonly service: string | null;
  readonly content: string;
}

/**
 * Splits a runbook into sections at its `##` headings. A `service:` line in the front matter (between
 * `---` lines) tags every section; the `#` title prefixes each section's. Text before the first
 * section is an `overview` section of its own.
 */
export function parseRunbook(path: string, markdown: string): RunbookSectionText[] {
  let body = markdown.replace(/\r\n/g, '\n');
  let service: string | null = null;
  const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(body);
  if (frontMatter) {
    const line = /^service:\s*(\S.*?)\s*$/m.exec(frontMatter[1] ?? '');
    service = line?.[1] ?? null;
    body = body.slice(frontMatter[0].length);
  }
  const heading = /^# (.+)$/m.exec(body);
  const document = heading?.[1]?.trim() ?? null;
  if (heading) body = body.replace(heading[0], '');

  const sections: RunbookSectionText[] = [];
  const anchors = new Map<string, number>();
  const add = (title: string, text: string) => {
    const content = text.trim();
    if (content === '') return;
    const slug = slugify(title) || 'section';
    const seen = anchors.get(slug) ?? 0;
    anchors.set(slug, seen + 1);
    sections.push({
      path,
      anchor: seen === 0 ? slug : `${slug}-${String(seen + 1)}`,
      title: document ? `${document}: ${title}` : title,
      service,
      content,
    });
  };
  const parts = body.split(/^## (.+)$/m);
  add('Overview', parts[0] ?? '');
  for (let i = 1; i < parts.length; i += 2) add((parts[i] ?? '').trim(), parts[i + 1] ?? '');
  return sections;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface RunbookReadError {
  readonly kind: 'read_failed';
  readonly message: string;
}

/** Every section of every `.md` file under `dir`, in path order. */
export async function readRunbooks(
  dir: string,
): Promise<Result<RunbookSectionText[], RunbookReadError>> {
  const files = await attempt(
    () => readdir(dir, { recursive: true }),
    (cause): RunbookReadError => ({ kind: 'read_failed', message: describe(cause) }),
  );
  if (!files.ok) return files;
  const sections: RunbookSectionText[] = [];
  for (const file of files.value.filter((name) => name.endsWith('.md')).sort()) {
    const text = await attempt(
      () => readFile(join(dir, file), 'utf8'),
      (cause): RunbookReadError => ({ kind: 'read_failed', message: describe(cause) }),
    );
    if (!text.ok) return text;
    sections.push(...parseRunbook(relative(dir, join(dir, file)), text.value));
  }
  return ok(sections);
}

/** What a section is embedded from: its title words matter as much as its body's. */
export function sectionText(section: Pick<RunbookSectionText, 'title' | 'content'>): string {
  return `${section.title}\n${section.content}`;
}

export type RunbookSyncError = RunbookReadError | EmbeddingError | DatabaseError;

/** Indexes the runbooks in `dir`: runbook_chunks ends up holding exactly their sections. */
export async function syncRunbooks(
  db: Database,
  dir: string,
  embedder: Embedder,
): Promise<Result<{ sections: number; written: number; deleted: number }, RunbookSyncError>> {
  const sections = await readRunbooks(dir);
  if (!sections.ok) return sections;
  const chunks = [];
  for (const section of sections.value) {
    const text = sectionText(section);
    const embedding = await embedder.embed(text);
    if (!embedding.ok) return embedding;
    chunks.push({
      ...section,
      contentHash: createHash('sha256').update(text).digest('hex'),
      embedder: embedder.name,
      embedding: embedding.value,
    });
  }
  const synced = await syncRunbookChunks(db, chunks);
  if (!synced.ok) return synced;
  return ok({ sections: chunks.length, ...synced.value });
}

/** get_runbook's backend: the indexed sections nearest the query. */
export function pgvectorRunbookIndex(db: Database, embedder: Embedder): RunbookIndex {
  return {
    async search({ text, service, k }) {
      const embedding = await embedder.embed(text);
      if (!embedding.ok) {
        return err({ kind: 'unavailable', message: `runbook search: ${embedding.error.message}` });
      }
      const matches = await searchRunbooks(db, embedding.value, { service, k });
      if (!matches.ok) {
        return err({ kind: 'unavailable', message: `runbook search: ${matches.error.message}` });
      }
      return ok(
        matches.value.map((match) => ({
          id: `${match.path}#${match.anchor}`,
          title: match.title,
          service: match.service,
          content: match.content,
          score: match.score,
        })),
      );
    },
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
