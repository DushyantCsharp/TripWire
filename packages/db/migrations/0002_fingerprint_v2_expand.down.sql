-- Loses fingerprint_v2 values; they are recomputed from labels by the backfill if 0002 is re-applied.
ALTER TABLE "alerts" DROP COLUMN IF EXISTS "fingerprint_v2";--> statement-breakpoint
DROP TABLE IF EXISTS "backfill_checkpoints";
