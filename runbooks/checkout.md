---
service: checkout
---

# Checkout

Places orders (`oteldemo.CheckoutService/PlaceOrder`). Go. It calls cart, product-catalog, currency,
shipping, payment and email in turn, then publishes the order to Kafka for accounting and fraud
detection. Because it calls so much, checkout errors are usually someone else's errors passed on.

## PlaceOrder errors

What you see: `HighErrorRate` on checkout and frontend 500s on `POST /api/checkout`.

Check first which dependency fails: the innermost failing span in checkout's failing traces names
the service at fault. Then:

- checkout's error logs: they quote the downstream error ("failed to charge card", "failed to get
  product", "failed to prepare order"). The quoted service is the suspect, not checkout.
- `sum by (service_name) (rate(traces_span_metrics_calls_total{status_code="STATUS_CODE_ERROR"}[5m]))`
  across services: the service whose errors started first is usually the root.

Likely causes: a failing dependency (most often); a recent change to checkout itself, including its
configuration (for example where it finds a dependency).

Mitigate: follow the dependency's runbook. Roll back checkout only if checkout changed.

## Orders not reaching Kafka

What you see: orders succeed for customers but accounting and fraud detection fall behind; checkout
logs errors or slowness publishing to Kafka.

Check: checkout's logs for producer errors or retries; the Kafka runbook for consumer lag.

Likely causes: Kafka unhealthy, a producer flooding the topic, or consumers falling behind.
