// Everything the model reads that came from outside Tripwire (alert labels and annotations, log
// lines, span messages, metric labels, deploy notes, runbooks, backend error text) is data, never
// instructions. It reaches the model as JSON inside one delimiter, and the JSON is escaped so that
// nothing inside can close that delimiter or open another: `<`, `>` and `&` become the JSON
// escapes for them (backslash-u003c and so on), which decode back to the same characters. The escaping is deterministic, so a
// recorded request hashes the same every time.

// Bidirectional overrides and isolates, and zero-width characters: invisible text that can hide or
// reorder what a reader (or the model) sees.
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** NFKC-normalises a string (so look-alike characters become plain ones) and drops invisibles. */
export function sanitizeText(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '');
}

/** JSON with every string sanitised and every character that could form markup escaped. */
export function untrustedJson(value: unknown): string {
  const json = JSON.stringify(value, (_key, nested: unknown) =>
    typeof nested === 'string' ? sanitizeText(nested) : nested,
  ) as string | undefined;
  if (json === undefined) throw new Error(`cannot serialise ${typeof value} as JSON`);
  return json.replace(/[<>&]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** The tag names the loop wraps untrusted data in. The system prompt names them too. */
export const TOOL_OUTPUT_TAG = 'tool_output';
export const INCIDENT_TAG = 'incident';

/** A tool's result (or error), as the model sees it. `tool` must be one of ours: it isn't escaped. */
export function wrapToolOutput(tool: string, value: unknown, error = false): string {
  const attributes = error ? ` tool="${tool}" error="true"` : ` tool="${tool}"`;
  return `<${TOOL_OUTPUT_TAG}${attributes}>\n${untrustedJson(value)}\n</${TOOL_OUTPUT_TAG}>`;
}

export function wrapIncident(value: unknown): string {
  return `<${INCIDENT_TAG}>\n${untrustedJson(value)}\n</${INCIDENT_TAG}>`;
}
