import { describe, expect, it } from '@jest/globals';
import { CLUSTER_SIMILARITY_THRESHOLD } from './replay/incident.js';
import { stormTemplates, templateSimilarity } from './storm.js';

// The load test's dedupe score is only readable if no two problems can merge, so that is checked
// here. Whether a problem's two rules merge is what the score measures (the load report prints
// their similarity), so it is not.
describe('the k6 storm templates', () => {
  it('raise 8 problems on 8 services, which the clustering can never merge', async () => {
    const templates = stormTemplates();
    expect(new Set(templates.map((t) => t.truth)).size).toBe(8);
    expect(new Set(templates.map((t) => t.service)).size).toBe(8);
    const { within, across } = await templateSimilarity(templates);
    expect(within.size).toBe(8);
    expect(across).toBeLessThan(CLUSTER_SIMILARITY_THRESHOLD);
  });
});
