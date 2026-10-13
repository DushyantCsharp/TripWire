CREATE TYPE "public"."fault_class" AS ENUM('application_error', 'unavailable', 'latency', 'cpu_saturation', 'memory_leak', 'gc_pressure', 'queue_backlog', 'traffic_surge', 'lock_contention', 'other');--> statement-breakpoint
CREATE TYPE "public"."triage_stop_reason" AS ENUM('report_submitted', 'tool_call_limit', 'input_token_budget', 'output_token_budget', 'wall_clock', 'invalid_output', 'refusal');--> statement-breakpoint
CREATE TABLE "runbook_chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"anchor" text NOT NULL,
	"title" text NOT NULL,
	"service" text,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedder" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runbook_chunks_path_anchor_key" UNIQUE("path","anchor"),
	CONSTRAINT "runbook_chunks_content_hash_sha256" CHECK ("runbook_chunks"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "hypotheses" ADD COLUMN "fault_class" "fault_class";--> statement-breakpoint
ALTER TABLE "triage_runs" ADD COLUMN "stop_reason" "triage_stop_reason";--> statement-breakpoint
CREATE UNIQUE INDEX "proposed_actions_pending_payload_key" ON "proposed_actions" USING btree ("incident_id","payload_hash") WHERE "proposed_actions"."status" = 'pending_approval';