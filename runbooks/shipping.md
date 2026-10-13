---
service: shipping
---

# Shipping and quote

shipping (Rust) quotes and ships orders (`GetQuote`, `ShipOrder`); it asks quote (PHP) for prices.
checkout calls shipping while placing an order, so slow shipping slows checkout.

## Slow shipping quotes

What you see: checkout latency up; shipping's `GetQuote` slow, sometimes only for some
destinations (international addresses, say).

Check:

- `histogram_quantile(0.95, sum by (le, span_name) (rate(traces_span_metrics_duration_milliseconds_bucket{service_name="shipping"}[5m])))`
- Whether quote is the slow part: quote's span durations inside shipping's traces.
- shipping's logs for which requests are slow.

Likely causes: a delay introduced by a recent change (deploy, configuration or feature flag), possibly
only on one code path; quote slow.

Mitigate: roll back the change. Page the shipping on-call.

## Shipping errors

Check whether quote fails first; shipping's errors quote it.
