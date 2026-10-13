---
service: email
---

# Email

Sends order confirmations (`/send_order_confirmation`). Ruby. checkout calls it after payment, so
slow email slows checkout.

## Memory growth

What you see: email's memory climbs steadily and never comes back down; requests slow as it grows;
eventually it restarts (an out-of-memory kill), and the climb starts again.

Check:

- email's resident memory over the last hour, e.g. `process_memory_usage` or the container's memory
  metric for email; a straight upward line that resets at restarts is a leak.
- email's latency: `histogram_quantile(0.95, sum by (le) (rate(traces_span_metrics_duration_milliseconds_bucket{service_name="email"}[5m])))`
- email's logs around restarts.

Likely causes: a leak introduced by a recent change (deploy or configuration); retained objects per
email sent, so the growth rate follows order volume.

Mitigate: roll back the change. A restart buys time but the memory climbs again. Page the email
on-call.

## Send errors

What you see: checkout logs failures sending confirmations; email error rate up.

Check: email's error logs; whether the mail transport is reachable.

Likely causes: the mail transport down, a template error after a change.
