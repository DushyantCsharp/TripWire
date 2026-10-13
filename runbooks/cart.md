---
service: cart
---

# Cart

Stores shopping carts (`oteldemo.CartService/AddItem`, `GetCart`, `EmptyCart`). .NET, backed by a
Valkey (Redis-compatible) store. The frontend calls it on every page with a cart; checkout empties
it after an order.

## Cart operation errors

What you see: errors on cart's `AddItem` or `GetCart`, frontend 500s on cart pages, and checkout
failing at `EmptyCart` or when reading the cart.

Check:

- Error rate by operation:
  `sum by (span_name) (rate(traces_span_metrics_calls_total{service_name="cart", status_code="STATUS_CODE_ERROR"}[5m]))`
- cart's error logs. A store problem shows connection or timeout errors to Valkey; an application
  fault shows the same exception on a share of requests with the store healthy.
- Traces through cart: whether the failing span is cart itself or its store client.

Likely causes:

- A recent change to cart (deploy, configuration or feature flag): errors start abruptly and hit a
  steady fraction of calls.
- The Valkey store is down, full, or refusing connections.

Mitigate: roll back the change; restore the store if it is down. Page the cart on-call.

## Health checks failing

What you see: cart reported not ready or not serving; the frontend gets intermittent cart errors as
instances drop out.

Check: cart's logs for health-check failures, and whether request rate to cart drops.

Likely causes: a dependency the health check probes (the store) is failing, or a change made the
health check itself fail.

Mitigate: fix the dependency, or roll back the change that broke the check.

## Slow cart operations

Check:
`histogram_quantile(0.95, sum by (le, span_name) (rate(traces_span_metrics_duration_milliseconds_bucket{service_name="cart"}[5m])))`

Likely causes: a slow store, store memory pressure, or CPU starvation.
