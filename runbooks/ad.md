---
service: ad
---

# Ad

Serves contextual ads to the frontend (`oteldemo.AdService/GetAds`). Java on the JVM. Ads are not
on the critical path: a failing ad service degrades pages but shouldn't fail checkout.

## GetAds errors

What you see: errors on ad's `GetAds` spans, ad slots empty on the storefront, frontend logging ad
request failures.

Check:

- `sum(rate(traces_span_metrics_calls_total{service_name="ad", status_code="STATUS_CODE_ERROR"}[5m]))`
- ad's error logs: one exception repeated on a share of requests, with no dependency failing, points
  at ad itself.

Likely causes: a recent change to ad (deploy, configuration or feature flag), or bad input from the
frontend.

Mitigate: roll back the change. Ads can be degraded while you do: page the ad on-call at low urgency.

## High CPU or slow ads

What you see: ad latency rising, frontend pages waiting on ads; JVM CPU near its limit.

Check:

- `histogram_quantile(0.95, sum by (le) (rate(traces_span_metrics_duration_milliseconds_bucket{service_name="ad"}[5m])))`
- JVM CPU and thread metrics for ad, e.g. `jvm_cpu_recent_utilization_ratio` or process CPU.

Likely causes: a code path doing far more work per request after a change; too little CPU for the
load.

Mitigate: roll back the change; scale ad out if load explains it.

## Garbage collection pauses

What you see: ad latency spikes in bursts; JVM GC metrics show long or frequent collections; heap
usage saw-tooths.

Check: `jvm_gc_duration_seconds` (count and sum, by gc and action) and `jvm_memory_used_bytes` for
ad.

Likely causes: a change forcing collections or allocating heavily; a heap too small for the load.

Mitigate: roll back the change; raise the heap if allocation is legitimate.
