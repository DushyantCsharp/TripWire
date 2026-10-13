-- Drops every table 0001 created, with all their data.
DROP TABLE IF EXISTS "approvals", "evidence", "hypotheses", "proposed_actions", "triage_runs", "incident_alerts", "incidents", "alerts", "ingests";--> statement-breakpoint
DROP FUNCTION IF EXISTS "approvals_append_only"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "proposed_actions_payload_immutable"();--> statement-breakpoint
DROP TYPE IF EXISTS "public"."action_kind", "public"."action_status", "public"."alert_match", "public"."alert_source", "public"."alert_status", "public"."approval_decision", "public"."evidence_kind", "public"."incident_status", "public"."severity", "public"."triage_failure_reason", "public"."triage_status";
