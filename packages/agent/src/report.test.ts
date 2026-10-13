import { describe, expect, it } from '@jest/globals';
import { parseReport } from './report.js';

const hypothesis = {
  title: 'payment Charge rejects tokens',
  explanation: 'payment logs show Invalid token since 12:04.',
  confidence: 0.8,
  suspect: 'payment',
  faultClass: 'application_error',
  evidence: ['log:pay-7f3a'],
};
const valid = { summary: 'payment is failing.', hypotheses: [hypothesis] };

describe('parseReport', () => {
  it('accepts a report that matches the schema', () => {
    expect(parseReport(JSON.stringify(valid))).toEqual({ ok: true, value: valid });
  });

  it.each([
    ['text that is not JSON', 'The root cause is payment.', 'not valid JSON (26 characters'],
    ['JSON cut off mid-way', '{"summary": "payment is', 'possibly cut off'],
    ['no hypotheses', JSON.stringify({ ...valid, hypotheses: [] }), 'hypotheses:'],
    [
      'four hypotheses',
      JSON.stringify({ ...valid, hypotheses: [hypothesis, hypothesis, hypothesis, hypothesis] }),
      'hypotheses:',
    ],
    [
      'a confidence above 1',
      JSON.stringify({ ...valid, hypotheses: [{ ...hypothesis, confidence: 1.5 }] }),
      'hypotheses.0.confidence',
    ],
    [
      'an unknown fault class',
      JSON.stringify({ ...valid, hypotheses: [{ ...hypothesis, faultClass: 'gremlins' }] }),
      'hypotheses.0.faultClass',
    ],
    [
      'an explanation that runs on',
      JSON.stringify({ ...valid, hypotheses: [{ ...hypothesis, explanation: 'x'.repeat(501) }] }),
      'hypotheses.0.explanation',
    ],
    ['extra fields', JSON.stringify({ ...valid, approved: true }), 'approved'],
  ])('rejects %s, saying where', (_case, text, message) => {
    const result = parseReport(text);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain(message);
  });

  it('keeps its complaint short: it goes back to the model with the whole conversation', () => {
    const many = { summary: '', hypotheses: Array.from({ length: 3 }, () => ({})) };
    const result = parseReport(JSON.stringify(many));
    expect(result.ok ? '' : result.error.length).toBeLessThanOrEqual(1_000);
  });
});
