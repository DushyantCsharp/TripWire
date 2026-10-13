---
service: load-generator
---

# Load generator

Synthetic users (Locust) browsing and buying in the storefront. Its traffic is most of what the shop
sees, so a change in its behaviour changes every service's load.

## Load generator flooding the storefront

What you see: request rate at the frontend many times its baseline, concentrated on a few routes
(the home page, say); latency up across services; no single service's errors explain it.

Check:

- The frontend's request rate by route, compared with an hour earlier.
- load-generator's logs and configuration: user count, spawn rate, the tasks it runs.

Likely causes: a configuration or feature-flag change to the load generator; a task stuck in a loop.

Mitigate: stop or throttle the load generator; roll back its change. Page the team that owns it.
