---
service: payment
---

# Payment

Charges cards for checkout (`oteldemo.PaymentService/Charge`). Node.js. Called only by checkout;
every failed charge fails an order, so payment problems show up as checkout and frontend errors.

## Charge errors

What you see: `HighErrorRate` or `GrpcServerErrors` on payment, with checkout `PlaceOrder` failing
and the frontend returning 500 on `POST /api/checkout`.

Check:

- Error rate by operation:
  `sum by (span_name) (rate(traces_span_metrics_calls_total{service_name="payment", status_code="STATUS_CODE_ERROR"}[5m]))`
- payment's error logs: `query_logs` with `service: payment`, `minSeverity: error`. Look for one
  repeated message (a rejected token, a declined card, a validation error) and whether it hits every
  request or a subset (one customer tier, one card type, one currency).
- Failing traces through checkout: the innermost failing span says whether payment raised the error
  or only passed one on.

Likely causes, most common first:

- A recent change to payment: a deploy or a configuration or feature-flag change. Errors that start
  at a precise moment and hit a fixed share of requests point here.
- A bad input pattern from checkout (malformed card data, unsupported currency).
- The card processor rejecting requests.

Mitigate: roll back the change that preceded the errors. Page the payment on-call if no change
explains them.

## Charge unreachable

What you see: checkout logs connection errors (`Unavailable`, `connection refused`, timeouts) when
calling payment, while payment itself logs nothing new and its own error rate looks normal or its
request rate drops to zero.

Check:

- Requests reaching payment:
  `sum(rate(traces_span_metrics_calls_total{service_name="payment", span_kind="SPAN_KIND_SERVER"}[5m]))`
- checkout's client spans to payment and their error messages.

Likely causes: payment is down or not ready, a wrong address or port in checkout's configuration,
or a network or service discovery problem. A configuration change in checkout can also point it at
the wrong place.

Mitigate: restore payment (restart, scale back up) or roll back the configuration change that broke
the route. Page the payment on-call.

## Slow charges

What you see: checkout latency rises with payment's p95.

Check:
`histogram_quantile(0.95, sum by (le) (rate(traces_span_metrics_duration_milliseconds_bucket{service_name="payment"}[5m])))`

Likely causes: the card processor responding slowly, CPU starvation, or a recent change.
