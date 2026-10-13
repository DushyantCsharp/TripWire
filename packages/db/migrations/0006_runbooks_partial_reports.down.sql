-- Drops everything 0006 added. Runbook sections are re-synced from the files by
-- `just runbooks-index`; partial-report reasons and fault classes are lost.
DROP INDEX IF EXISTS "proposed_actions_pending_payload_key";--> statement-breakpoint
ALTER TABLE "triage_runs" DROP COLUMN IF EXISTS "stop_reason";--> statement-breakpoint
ALTER TABLE "hypotheses" DROP COLUMN IF EXISTS "fault_class";--> statement-breakpoint
DROP TABLE IF EXISTS "runbook_chunks";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."triage_stop_reason";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."fault_class";
