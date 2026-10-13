---
service: image-provider
---

# Image provider

Serves product images (nginx), reached through frontend-proxy at `/images/`. Slow images make pages
feel slow to customers without failing any backend call.

## Slow image loads

What you see: page load times up for browser users; image requests through frontend-proxy slow;
backend services healthy.

Check:

- Latency of image requests at frontend-proxy and image-provider:
  `histogram_quantile(0.95, sum by (le, service_name) (rate(traces_span_metrics_duration_milliseconds_bucket{service_name=~"image-provider|frontend-proxy"}[5m])))`
- frontend-proxy's logs and traces for `/images/` routes, including injected delays or faults.

Likely causes: a delay introduced on the image route (a proxy fault-injection or route change, a
feature flag), a slow disk or cache on image-provider.

Mitigate: roll back the route or configuration change; page the frontend on-call.
