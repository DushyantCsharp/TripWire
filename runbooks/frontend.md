---
service: frontend
---

# Frontend and frontend-proxy

The storefront (Next.js), behind frontend-proxy (Envoy), which also routes `/images/`, `/feature`,
`/jaeger` and `/grafana`. The frontend calls almost every service, so its errors are usually symptoms:
find the backend that fails first.

## HTTP 5xx from the frontend

What you see: `HighErrorRate` on frontend; 500s on `/api/checkout`, `/api/cart`, `/api/products`.

Check:

- Which route fails:
  `sum by (span_name) (rate(traces_span_metrics_calls_total{service_name="frontend", status_code="STATUS_CODE_ERROR"}[5m]))`
- The innermost failing span of failing frontend traces: it names the backend at fault.
- frontend's logs: they quote the backend error.

Likely causes: a backend failing (checkout, cart, product-catalog, payment); a recent frontend
change.

Mitigate: follow the failing backend's runbook. Roll back the frontend only if it changed.

## Traffic surge

What you see: request rate at frontend-proxy and frontend far above normal, latency rising across
many services at once, errors from saturation rather than from one fault.

Check:

- Request rate by route:
  `sum by (span_name) (rate(traces_span_metrics_calls_total{service_name="frontend", span_kind="SPAN_KIND_SERVER"}[5m]))`
- Where the traffic comes from: client addresses and user agents at the proxy; a synthetic load
  source sending many times its usual volume.

Likely causes: a load source misbehaving after a change; a real spike; a retry storm.

Mitigate: throttle or stop the source; scale the frontend. Page the frontend on-call.

## Proxy errors and slow routes

What you see: 503s or added latency at frontend-proxy for one route while the upstream service is
healthy.

Likely causes: a route, timeout or fault-injection change in the proxy's configuration.

Mitigate: roll back the proxy configuration change.
