---
service: recommendation
---

# Recommendation

Suggests products (`oteldemo.RecommendationService/ListRecommendations`). Python. It reads the
catalog from product-catalog and keeps a cache of product ids.

## Memory growth and slow recommendations

What you see: recommendation's memory climbs; `ListRecommendations` gets slower; the frontend's
product pages wait on it.

Check:

- recommendation's memory over time (`process_runtime_cpython_memory_bytes` or the container's
  memory metric) and its latency:
  `histogram_quantile(0.95, sum by (le) (rate(traces_span_metrics_duration_milliseconds_bucket{service_name="recommendation"}[5m])))`
- recommendation's logs for cache size or cache misses.

Likely causes: a cache that grows without bound after a recent change (deploy, configuration or
feature flag), or that never evicts; heavy calls to product-catalog on every request.

Mitigate: roll back the change; restart to clear the cache while you do. Page the recommendation
on-call.

## Recommendation errors

Check whether product-catalog is failing first: recommendation's errors often quote it.
