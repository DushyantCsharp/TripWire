---
service: kafka
---

# Kafka, accounting and fraud detection

checkout publishes every order to the `orders` topic in Kafka. accounting (.NET) and
fraud-detection (Kotlin) consume it. Problems here don't fail orders for customers; they make the
consumers fall behind.

## Consumer lag and queue problems

What you see: consumer lag rising on the `orders` topic; accounting and fraud-detection processing
slowly or erroring; checkout's publish latency up; possibly far more messages produced than orders
placed.

Check:

- Kafka consumer lag and broker metrics (lag by consumer group, produce and fetch rates).
- checkout's logs for producer errors, retries or unusual publish volume.
- fraud-detection and accounting logs: slow processing per message, or errors.
- Latency of the consumers' spans:
  `histogram_quantile(0.95, sum by (le, service_name) (rate(traces_span_metrics_duration_milliseconds_bucket{service_name=~"accounting|fraud-detection"}[5m])))`

Likely causes: a producer flooding the topic after a change; a consumer slowed by a change; the
broker overloaded or out of disk.

Mitigate: roll back the change on the producer or consumer that caused it; scale consumers to work
off the lag. Page the owning team.
