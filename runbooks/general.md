# Triage

Applies to every service.

## Finding the root of a cascade

When many services alert at once, most of them are passing on another's failure.

- Start from the incident's earliest alerts, not its loudest.
- In failing traces, the innermost failing span is the likeliest origin; spans above it fail
  because it did.
- A service whose logs quote another service's error is a victim of that service.
- Error rates that rise together across services usually share one cause; the service whose errors
  start first is the best suspect.

## Changes come first

Most incidents follow a change: a deploy, a configuration change, or a feature-flag change. Look at
what changed in the hour before the first alert, for the suspect service and for its dependencies.
An error that starts at an exact moment and affects a steady fraction of requests usually comes from
a change rather than from load or hardware.

## Telemetry that's missing

If a backend (logs, traces, metrics) is unavailable, carry on with the others and say so; don't
treat missing data as evidence that nothing is wrong.

## Actions

Prefer the smallest action that addresses the cause: roll back the change that started it, scale a
service that is saturated, page the owning team when the cause is unclear. Every action needs a
person's approval before it runs.
