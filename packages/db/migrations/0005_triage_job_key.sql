ALTER TYPE "public"."triage_failure_reason" ADD VALUE 'invalid_output';--> statement-breakpoint
ALTER TYPE "public"."triage_failure_reason" ADD VALUE 'request_rejected';--> statement-breakpoint
ALTER TYPE "public"."triage_failure_reason" ADD VALUE 'internal_error';--> statement-breakpoint
ALTER TABLE "triage_runs" ADD COLUMN "job_key" text;--> statement-breakpoint
ALTER TABLE "triage_runs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_runs" ADD CONSTRAINT "triage_runs_job_key_key" UNIQUE("job_key");