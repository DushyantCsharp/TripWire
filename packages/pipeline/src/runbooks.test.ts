import { describe, expect, it } from '@jest/globals';
import { parseRunbook, slugify } from './runbooks.js';

const PAYMENT = `---
service: payment
owner: payments-team
---
# Payment

Handles card charges for checkout.

## Charge failures

Symptoms: Charge returns errors.

## Charge failures

A second section with the same heading.

## Latency (p95 > 1s)
`;

describe('parseRunbook', () => {
  it('splits at ## headings, tags sections with the front matter service, and titles them', () => {
    expect(parseRunbook('payment.md', PAYMENT)).toEqual([
      {
        path: 'payment.md',
        anchor: 'overview',
        title: 'Payment: Overview',
        service: 'payment',
        content: 'Handles card charges for checkout.',
      },
      {
        path: 'payment.md',
        anchor: 'charge-failures',
        title: 'Payment: Charge failures',
        service: 'payment',
        content: 'Symptoms: Charge returns errors.',
      },
      {
        path: 'payment.md',
        anchor: 'charge-failures-2',
        title: 'Payment: Charge failures',
        service: 'payment',
        content: 'A second section with the same heading.',
      },
    ]);
  });

  it('reads a runbook without front matter or a title as general', () => {
    expect(parseRunbook('general.md', '## Triage\r\nStart from the alerts.\r\n')).toEqual([
      {
        path: 'general.md',
        anchor: 'triage',
        title: 'Triage',
        service: null,
        content: 'Start from the alerts.',
      },
    ]);
  });

  it.each([
    ['Charge failures', 'charge-failures'],
    ['Latency (p95 > 1s)', 'latency-p95-1s'],
    ['  --Valkey/Redis down!-- ', 'valkey-redis-down'],
  ])('slugs %j as %j', (text, slug) => {
    expect(slugify(text)).toBe(slug);
  });
});
