-- Postgres can't drop enum values, so the type is rebuilt without the three 0005 added. Runs that
-- failed for one of them are relabelled model_unavailable, the closest earlier reason.
ALTER TABLE "triage_runs" DROP CONSTRAINT IF EXISTS "triage_runs_job_key_key";--> statement-breakpoint
ALTER TABLE "triage_runs" DROP COLUMN IF EXISTS "attempts";--> statement-breakpoint
ALTER TABLE "triage_runs" DROP COLUMN IF EXISTS "job_key";--> statement-breakpoint
UPDATE "triage_runs" SET "failure_reason" = 'model_unavailable'
  WHERE "failure_reason" IN ('invalid_output', 'request_rejected', 'internal_error');--> statement-breakpoint
ALTER TYPE "public"."triage_failure_reason" RENAME TO "triage_failure_reason_0005";--> statement-breakpoint
CREATE TYPE "public"."triage_failure_reason" AS ENUM('token_budget_exhausted', 'tool_call_limit_reached', 'model_unavailable', 'timed_out');--> statement-breakpoint
ALTER TABLE "triage_runs" ALTER COLUMN "failure_reason" TYPE "public"."triage_failure_reason"
  USING "failure_reason"::text::"public"."triage_failure_reason";--> statement-breakpoint
DROP TYPE "public"."triage_failure_reason_0005";
