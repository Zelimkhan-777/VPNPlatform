-- Keep monetary, lifecycle, and configuration state valid even if a future
-- caller bypasses application-level validation.
ALTER TABLE "Plan"
  ADD CONSTRAINT "Plan_priceMinor_positive" CHECK ("priceMinor" > 0),
  ADD CONSTRAINT "Plan_deviceLimit_positive" CHECK ("deviceLimit" > 0);

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_dates_complete_and_ordered"
  CHECK (
    ("startsAt" IS NULL AND "expiresAt" IS NULL)
    OR (
      "startsAt" IS NOT NULL
      AND "expiresAt" IS NOT NULL
      AND "expiresAt" > "startsAt"
    )
  ),
  ADD CONSTRAINT "Subscription_active_has_access_period"
  CHECK (
    "status" <> 'ACTIVE'
    OR ("startsAt" IS NOT NULL AND "expiresAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "Subscription_cancelled_has_timestamp"
  CHECK ("status" <> 'CANCELLED' OR "cancelledAt" IS NOT NULL);

ALTER TABLE "Device"
  ADD CONSTRAINT "Device_revoked_has_timestamp"
  CHECK ("status" <> 'REVOKED' OR "revokedAt" IS NOT NULL),
  ADD CONSTRAINT "Device_active_has_no_revocation_timestamp"
  CHECK ("status" <> 'ACTIVE' OR "revokedAt" IS NULL);

ALTER TABLE "Node"
  ADD CONSTRAINT "Node_config_versions_ordered"
  CHECK (
    "desiredConfigVersion" >= 0
    AND "appliedConfigVersion" >= 0
    AND "appliedConfigVersion" <= "desiredConfigVersion"
  );

ALTER TABLE "NodeAccessGrant"
  ADD CONSTRAINT "NodeAccessGrant_versions_ordered"
  CHECK (
    "desiredVersion" >= 0
    AND "appliedVersion" >= 0
    AND "appliedVersion" <= "desiredVersion"
  ),
  ADD CONSTRAINT "NodeAccessGrant_revoked_has_timestamp"
  CHECK ("status" <> 'REVOKED' OR "revokedAt" IS NOT NULL);

ALTER TABLE "NodeSyncJob"
  ADD CONSTRAINT "NodeSyncJob_attempts_nonnegative" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "NodeSyncJob_targetVersion_nonnegative" CHECK ("targetVersion" >= 0);

ALTER TABLE "OutboxEvent"
  ADD CONSTRAINT "OutboxEvent_attempts_nonnegative" CHECK ("attempts" >= 0);
