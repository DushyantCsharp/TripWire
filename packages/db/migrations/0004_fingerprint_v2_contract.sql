-- tripwire:no-transaction
-- Contract step of the fingerprint_v2 change. Run only after the backfill has finished and dedupe
-- reads use v2 (MIGRATIONS.md). Every statement is safe to re-run.
--
-- A bare SET NOT NULL scans the whole table under ACCESS EXCLUSIVE, blocking reads and writes.
-- Instead: an instant NOT VALID check, VALIDATE (scans under SHARE UPDATE EXCLUSIVE, so writes go
-- on), then SET NOT NULL, which Postgres proves from the validated check without a second scan.

-- Fail fast, before adding anything, if the backfill hasn't finished (uses the 0003 index).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "alerts" WHERE "fingerprint_v2" IS NULL) THEN
    RAISE EXCEPTION 'alerts.fingerprint_v2 still has NULL rows: finish the backfill before 0004 (packages/db/MIGRATIONS.md)';
  END IF;
END $$;--> statement-breakpoint
-- Leftover from an attempt that failed at VALIDATE (a NULL row raced in after the check above).
ALTER TABLE "alerts" DROP CONSTRAINT IF EXISTS "alerts_fingerprint_v2_not_null";--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_fingerprint_v2_not_null" CHECK ("fingerprint_v2" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "alerts" VALIDATE CONSTRAINT "alerts_fingerprint_v2_not_null";--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "fingerprint_v2" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_fingerprint_v2_not_null";--> statement-breakpoint
-- Reads moved to the v2 index before this migration, so the v1 index is dead weight on every write.
DROP INDEX CONCURRENTLY IF EXISTS "alerts_fingerprint_received_at_idx";
