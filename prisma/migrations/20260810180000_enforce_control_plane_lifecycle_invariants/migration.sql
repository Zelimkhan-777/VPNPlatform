-- Keep lifecycle state transitions valid even if application code is bypassed.
CREATE UNIQUE INDEX "Subscription_one_active_per_user"
  ON "Subscription" ("userId")
  WHERE "status" = 'ACTIVE';

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_cancelledAt_matches_status"
  CHECK (
    ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL)
    OR ("status" <> 'CANCELLED' AND "cancelledAt" IS NULL)
  );

ALTER TABLE "NodeAccessGrant"
  ADD CONSTRAINT "NodeAccessGrant_active_has_no_revocation_timestamp"
  CHECK ("status" <> 'ACTIVE' OR "revokedAt" IS NULL);

ALTER TABLE "NodeSyncJob"
  ADD CONSTRAINT "NodeSyncJob_terminal_has_completion_timestamp"
  CHECK (
    "status" NOT IN ('SUCCEEDED', 'FAILED')
    OR "completedAt" IS NOT NULL
  );

ALTER TABLE "OutboxEvent"
  ADD CONSTRAINT "OutboxEvent_published_has_publication_timestamp"
  CHECK ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL);
