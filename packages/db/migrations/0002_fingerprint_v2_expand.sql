CREATE TABLE "backfill_checkpoints" (
	"name" text PRIMARY KEY NOT NULL,
	"last_id" uuid,
	"rows_done" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "fingerprint_v2" text;