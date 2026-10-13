-- tripwire:no-transaction
-- Builds the v2 dedupe index without blocking writes; CONCURRENTLY can't run inside a transaction.
-- A failed concurrent build leaves an INVALID index behind, so drop any leftover first: this
-- migration only runs while unrecorded, so a rerun simply rebuilds.
DROP INDEX CONCURRENTLY IF EXISTS "alerts_fingerprint_v2_received_at_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "alerts_fingerprint_v2_received_at_idx" ON "alerts" USING btree ("fingerprint_v2","received_at" DESC NULLS FIRST);
