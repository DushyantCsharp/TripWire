-- tripwire:no-transaction
-- Restore the v1 index first so v1 dedupe reads have it again, then relax the column.
-- Drop-then-create: a failed concurrent build leaves an INVALID index that IF NOT EXISTS would keep.
DROP INDEX CONCURRENTLY IF EXISTS "alerts_fingerprint_received_at_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "alerts_fingerprint_received_at_idx" ON "alerts" USING btree ("fingerprint","received_at" DESC NULLS FIRST);--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT IF EXISTS "alerts_fingerprint_v2_not_null";--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "fingerprint_v2" DROP NOT NULL;
