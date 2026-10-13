CREATE TYPE "public"."action_kind" AS ENUM('rollback', 'scale', 'page');--> statement-breakpoint
CREATE TYPE "public"."action_status" AS ENUM('pending_approval', 'approved', 'rejected', 'expired', 'executed', 'execution_failed');--> statement-breakpoint
CREATE TYPE "public"."alert_match" AS ENUM('fingerprint', 'embedding', 'new_incident');--> statement-breakpoint
CREATE TYPE "public"."alert_source" AS ENUM('alertmanager', 'generic');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('firing', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."approval_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."evidence_kind" AS ENUM('log', 'trace', 'metric', 'deploy', 'runbook');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('open', 'triaging', 'triaged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('critical', 'warning', 'info');--> statement-breakpoint
CREATE TYPE "public"."triage_failure_reason" AS ENUM('token_budget_exhausted', 'tool_call_limit_reached', 'model_unavailable', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."triage_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ingest_id" uuid NOT NULL,
	"source" "alert_source" NOT NULL,
	"name" text NOT NULL,
	"status" "alert_status" NOT NULL,
	"severity" "severity" NOT NULL,
	"service" text,
	"summary" text,
	"labels" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"raw_payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"action_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"decision" "approval_decision" NOT NULL,
	"reason" text NOT NULL,
	"payload_hash" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "approvals_action_id_key" UNIQUE("action_id"),
	CONSTRAINT "approvals_reason_not_blank" CHECK (length(btrim("approvals"."reason")) BETWEEN 1 AND 2000),
	CONSTRAINT "approvals_expiry_iff_approved" CHECK (("approvals"."decision" = 'approved') = ("approvals"."expires_at" IS NOT NULL)),
	CONSTRAINT "approvals_consumed_only_if_approved" CHECK ("approvals"."consumed_at" IS NULL OR "approvals"."decision" = 'approved')
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"triage_run_id" uuid NOT NULL,
	"hypothesis_id" uuid,
	"kind" "evidence_kind" NOT NULL,
	"source_id" text NOT NULL,
	"excerpt" text,
	"available" boolean NOT NULL,
	"unavailable_reason" text,
	"url" text,
	CONSTRAINT "evidence_unavailable_has_reason" CHECK ("evidence"."available" OR "evidence"."unavailable_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "hypotheses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"triage_run_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"title" text NOT NULL,
	"explanation" text NOT NULL,
	"confidence" real NOT NULL,
	"suspect" text,
	CONSTRAINT "hypotheses_triage_run_id_rank_key" UNIQUE("triage_run_id","rank"),
	CONSTRAINT "hypotheses_rank_positive" CHECK ("hypotheses"."rank" >= 1),
	CONSTRAINT "hypotheses_confidence_range" CHECK ("hypotheses"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "incident_alerts" (
	"incident_id" uuid NOT NULL,
	"alert_id" uuid NOT NULL,
	"match" "alert_match" NOT NULL,
	"similarity" real,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_alerts_pkey" PRIMARY KEY("incident_id","alert_id"),
	CONSTRAINT "incident_alerts_alert_id_key" UNIQUE("alert_id"),
	CONSTRAINT "incident_alerts_similarity_range" CHECK ("incident_alerts"."similarity" IS NULL OR "incident_alerts"."similarity" BETWEEN -1 AND 1)
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"status" "incident_status" DEFAULT 'open' NOT NULL,
	"severity" "severity" NOT NULL,
	"service" text,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"alert_count" integer DEFAULT 0 NOT NULL,
	"embedding" vector(1024),
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_seen_order" CHECK ("incidents"."last_seen" >= "incidents"."first_seen"),
	CONSTRAINT "incidents_alert_count_non_negative" CHECK ("incidents"."alert_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ingests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"body_hash" text NOT NULL,
	"source" "alert_source" NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"alert_count" integer NOT NULL,
	CONSTRAINT "ingests_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "ingests_body_hash_sha256" CHECK ("ingests"."body_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ingests_alert_count_positive" CHECK ("ingests"."alert_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "proposed_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"triage_run_id" uuid NOT NULL,
	"kind" "action_kind" NOT NULL,
	"summary" text NOT NULL,
	"rationale" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"status" "action_status" DEFAULT 'pending_approval' NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposed_actions_id_payload_hash_key" UNIQUE("id","payload_hash"),
	CONSTRAINT "proposed_actions_payload_hash_sha256" CHECK ("proposed_actions"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "triage_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"status" "triage_status" DEFAULT 'queued' NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"summary" text,
	"confidence" real,
	"failure_reason" "triage_failure_reason",
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "triage_runs_counters_non_negative" CHECK ("triage_runs"."tokens_in" >= 0 AND "triage_runs"."tokens_out" >= 0 AND "triage_runs"."tool_calls" >= 0 AND "triage_runs"."cost_usd_micros" >= 0),
	CONSTRAINT "triage_runs_confidence_range" CHECK ("triage_runs"."confidence" IS NULL OR "triage_runs"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "triage_runs_failure_has_reason" CHECK (("triage_runs"."status" = 'failed') = ("triage_runs"."failure_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_ingest_id_ingests_id_fk" FOREIGN KEY ("ingest_id") REFERENCES "public"."ingests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_payload_fkey" FOREIGN KEY ("action_id","payload_hash") REFERENCES "public"."proposed_actions"("id","payload_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_triage_run_id_triage_runs_id_fk" FOREIGN KEY ("triage_run_id") REFERENCES "public"."triage_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_hypothesis_id_hypotheses_id_fk" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."hypotheses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_triage_run_id_triage_runs_id_fk" FOREIGN KEY ("triage_run_id") REFERENCES "public"."triage_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_alerts" ADD CONSTRAINT "incident_alerts_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_alerts" ADD CONSTRAINT "incident_alerts_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposed_actions" ADD CONSTRAINT "proposed_actions_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposed_actions" ADD CONSTRAINT "proposed_actions_triage_run_id_triage_runs_id_fk" FOREIGN KEY ("triage_run_id") REFERENCES "public"."triage_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_runs" ADD CONSTRAINT "triage_runs_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_fingerprint_received_at_idx" ON "alerts" USING btree ("fingerprint","received_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "alerts_ingest_id_idx" ON "alerts" USING btree ("ingest_id");--> statement-breakpoint
CREATE INDEX "evidence_triage_run_id_idx" ON "evidence" USING btree ("triage_run_id");--> statement-breakpoint
CREATE INDEX "evidence_hypothesis_id_idx" ON "evidence" USING btree ("hypothesis_id");--> statement-breakpoint
CREATE INDEX "incidents_last_seen_id_idx" ON "incidents" USING btree ("last_seen" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "incidents_embedding_hnsw_idx" ON "incidents" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "proposed_actions_incident_id_idx" ON "proposed_actions" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "proposed_actions_triage_run_id_idx" ON "proposed_actions" USING btree ("triage_run_id");--> statement-breakpoint
CREATE INDEX "triage_runs_incident_id_created_at_idx" ON "triage_runs" USING btree ("incident_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
-- Hand-written below: triggers that hold the approval invariant at the database (see CLAUDE.md).
-- An action's payload is what gets approved and executed, so it can never change after insert.
CREATE FUNCTION "proposed_actions_payload_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash THEN
    RAISE EXCEPTION 'proposed_actions.payload is immutable (action %)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "proposed_actions_payload_immutable" BEFORE UPDATE OF "payload", "payload_hash" ON "proposed_actions"
  FOR EACH ROW EXECUTE FUNCTION "proposed_actions_payload_immutable"();--> statement-breakpoint
-- Approvals are an audit record: never deleted, and the only allowed change is consuming an
-- approved, unconsumed record exactly once.
CREATE FUNCTION "approvals_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approvals are append-only (approval %)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.id, NEW.action_id, NEW.actor, NEW.decision, NEW.reason, NEW.payload_hash, NEW.decided_at, NEW.expires_at)
       IS DISTINCT FROM
     (OLD.id, OLD.action_id, OLD.actor, OLD.decision, OLD.reason, OLD.payload_hash, OLD.decided_at, OLD.expires_at)
     OR OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'approvals are append-only; only an unconsumed approval''s consumed_at may be set (approval %)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "approvals_append_only" BEFORE UPDATE OR DELETE ON "approvals"
  FOR EACH ROW EXECUTE FUNCTION "approvals_append_only"();