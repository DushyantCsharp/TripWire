---
service: currency
---

# Currency

Converts prices (`oteldemo.CurrencyService/Convert`). C++. The frontend and checkout call it on
nearly every request.

## Conversion errors or latency

What you see: errors or latency on `Convert`; frontend prices missing; checkout failing to total an
order.

Check:

- `sum(rate(traces_span_metrics_calls_total{service_name="currency", status_code="STATUS_CODE_ERROR"}[5m]))`
- currency's logs for unsupported currencies or conversion failures.

Likely causes: a recent change; an unsupported currency code from a caller.

Mitigate: roll back the change. Page the currency on-call.
