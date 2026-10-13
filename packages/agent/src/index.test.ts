import { describe, expect, it } from '@jest/globals';
import { modelTools, READ_TOOL_NAMES } from './index.js';

describe('@tripwire/agent', () => {
  it('offers the model read-only tools, and propose_action, which only records a proposal', () => {
    expect(modelTools(READ_TOOL_NAMES).map((tool) => tool.name)).toEqual([
      'query_logs',
      'query_traces',
      'query_metrics',
      'list_deploys',
      'get_runbook',
      'propose_action',
    ]);
  });
});
