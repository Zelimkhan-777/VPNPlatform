-- A scheduled retry belongs only to pending work. Claimed and terminal work
-- must not retain a retry timestamp that could be acted on by another worker.
ALTER TABLE "NodeSyncJob"
  ADD CONSTRAINT "NodeSyncJob_retry_scheduled_only_while_pending"
  CHECK ("status" = 'PENDING' OR "nextAttemptAt" IS NULL);

ALTER TABLE "OutboxEvent"
  ADD CONSTRAINT "OutboxEvent_retry_scheduled_only_while_pending"
  CHECK ("status" = 'PENDING' OR "nextAttemptAt" IS NULL);
