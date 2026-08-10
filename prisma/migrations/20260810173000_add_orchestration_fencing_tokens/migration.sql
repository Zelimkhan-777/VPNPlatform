ALTER TABLE "NodeSyncJob" ADD COLUMN "leaseToken" UUID;
ALTER TABLE "NodeSyncJob" DROP CONSTRAINT "NodeSyncJob_processing_has_lease";
ALTER TABLE "NodeSyncJob" ADD CONSTRAINT "NodeSyncJob_processing_has_lease" CHECK (("status" = 'PROCESSING' AND "leaseOwner" IS NOT NULL AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL) OR ("status" <> 'PROCESSING' AND "leaseOwner" IS NULL AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL));
ALTER TABLE "OutboxEvent" ADD COLUMN "leaseToken" UUID;
ALTER TABLE "OutboxEvent" DROP CONSTRAINT "OutboxEvent_processing_has_lease";
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_processing_has_lease" CHECK (("status" = 'PROCESSING' AND "leaseOwner" IS NOT NULL AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL) OR ("status" <> 'PROCESSING' AND "leaseOwner" IS NULL AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL));
