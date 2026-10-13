---
service: product-catalog
---

# Product catalog

Lists and looks up products (`oteldemo.ProductCatalogService/GetProduct`, `ListProducts`,
`SearchProducts`). Go, backed by a Postgres database (astronomy-db). The frontend, checkout and
recommendation all call it, so its failures spread widely.

## GetProduct errors

What you see: errors from `GetProduct`, often for particular products; frontend product pages
failing; checkout failing to prepare orders; recommendation errors quoting the catalog.

Check:

- `sum by (span_name) (rate(traces_span_metrics_calls_total{service_name="product-catalog", status_code="STATUS_CODE_ERROR"}[5m]))`
- product-catalog's error logs: is it one product id, or every lookup?
- Traces: errors in frontend, checkout and recommendation whose innermost failing span is in
  product-catalog.

Likely causes: a recent change (deploy, configuration or feature flag), sometimes affecting only
certain products; bad catalog data; the database unavailable.

Mitigate: roll back the change; page the product-catalog on-call.

## Slow queries and lock contention

What you see: product-catalog latency spikes and timeouts while the database is reachable; database
spans waiting a long time; requests piling up.

Check:

- `histogram_quantile(0.95, sum by (le, span_name) (rate(traces_span_metrics_duration_milliseconds_bucket{service_name="product-catalog"}[5m])))`
- Database client spans and metrics (`db_client_operation_duration_seconds`) for long waits.

Likely causes: queries blocked on locks held by another transaction (a long write, a migration, a
change that started holding locks); a missing index after a change.

Mitigate: find and end the blocking transaction; roll back the change that introduced it.
