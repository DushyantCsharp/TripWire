import { afterAll, describe, expect, it } from '@jest/globals';
import {
  answer,
  PAYMENT_INCIDENT,
  scriptedModel,
  SCENARIO_BUDGET,
  toolUse,
} from '@tripwire/agent/testing';
import { createDatabase } from '@tripwire/db';
import { hashingEmbedder } from '@tripwire/pipeline';
import { parseEnv } from '@tripwire/config';
import { workerEnv } from '../config.js';
import { createTriager } from './triager.js';

// A pool that never connects: nothing here queries the database.
const { db, pool } = createDatabase('postgres://localhost:1/unused');
afterAll(() => pool.end());

const required = {
  REDIS_URL: 'redis://localhost:6379',
  DATABASE_URL: 'postgres://localhost/tripwire',
};
const silent = { info: () => undefined, error: () => undefined };

function config(env: Record<string, string>) {
  const parsed = parseEnv(workerEnv, { ...required, ...env });
  if (!parsed.ok) throw new Error(parsed.error.issues.join('; '));
  return parsed.value;
}

describe('worker triager', () => {
  it('runs the model-free baseline unless told otherwise, even with a key present', () => {
    const triager = createTriager(config({ ANTHROPIC_API_KEY: 'sk-test' }), {
      db,
      embedder: hashingEmbedder(),
      log: silent,
    });
    expect(triager.model).toBe('baseline-v1');
  });

  it('refuses TRIAGER=claude without a key', () => {
    expect(parseEnv(workerEnv, { ...required, TRIAGER: 'claude' })).toEqual({
      ok: false,
      error: {
        kind: 'invalid_env',
        issues: ['ANTHROPIC_API_KEY: TRIAGER=claude needs ANTHROPIC_API_KEY'],
      },
    });
  });

  it('offers the tools whose backends are configured, and reports the rest as unavailable', async () => {
    const model = scriptedModel([
      toolUse([{ name: 'query_logs', input: { service: 'payment' } }]),
      answer({
        summary: 'Unknown: logs are unavailable.',
        hypotheses: [
          {
            title: 'payment',
            explanation: 'alerts only',
            confidence: 0.2,
            suspect: 'payment',
            faultClass: 'other',
            evidence: [],
          },
        ],
      }),
    ]);
    const triager = createTriager(
      config({ TRIAGER: 'claude', ANTHROPIC_API_KEY: 'sk-test', TRIAGE_MODEL: 'claude-opus-5-5' }),
      { db, embedder: hashingEmbedder(), log: silent, client: model },
    );
    const result = await triager.triage(PAYMENT_INCIDENT, {
      budget: SCENARIO_BUDGET,
      runKey: 'job-1',
    });

    expect(triager.model).toBe('claude-opus-5-5');
    // No change feed configured: list_deploys isn't offered at all.
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      'query_logs',
      'query_traces',
      'query_metrics',
      'get_runbook',
      'propose_action',
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        unavailableEvidence: [
          {
            kind: 'log',
            unavailableReason: 'the log backend is not configured (LOGS_OPENSEARCH_URL)',
          },
        ],
      },
    });
  });

  it('offers list_deploys when a change feed is configured', async () => {
    const model = scriptedModel([answer('{}'), answer('{}')]);
    const triager = createTriager(
      config({
        TRIAGER: 'claude',
        ANTHROPIC_API_KEY: 'sk-test',
        DEPLOYS_URL: 'http://cd.internal/changes',
      }),
      { db, embedder: hashingEmbedder(), log: silent, client: model },
    );
    await triager.triage(PAYMENT_INCIDENT, { budget: SCENARIO_BUDGET, runKey: 'job-2' });
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toContain('list_deploys');
  });
});
