ALTER TABLE "NodeSyncJob"
  ADD COLUMN "leaseOwner" VARCHAR(128),
  ADD COLUMN "leaseExpiresAt" TIMESTAMPTZ(6),
  ADD CONSTRAINT "NodeSyncJob_processing_has_lease"
  CHECK (
    ("status" = 'PROCESSING' AND "leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
    OR ("status" <> 'PROCESSING' AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL)
  );
CREATE INDEX "NodeSyncJob_status_leaseExpiresAt_idx" ON "NodeSyncJob"("status", "leaseExpiresAt");

ALTER TABLE "OutboxEvent"
  ADD COLUMN "leaseOwner" VARCHAR(128),
  ADD COLUMN "leaseExpiresAt" TIMESTAMPTZ(6),
  ADD CONSTRAINT "OutboxEvent_processing_has_lease"
  CHECK (
    ("status" = 'PROCESSING' AND "leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
    OR ("status" <> 'PROCESSING' AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL)
  );
CREATE INDEX "OutboxEvent_status_leaseExpiresAt_idx" ON "OutboxEvent"("status", "leaseExpiresAt");
