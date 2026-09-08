CREATE TABLE "HealthPolicyVersion" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HealthPolicyVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HealthPolicyVersion_config_object_check"
      CHECK (jsonb_typeof("config") = 'object')
);

CREATE UNIQUE INDEX "HealthPolicyVersion_code_key"
  ON "HealthPolicyVersion"("code");

CREATE TABLE "CapacityPolicyVersion" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CapacityPolicyVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CapacityPolicyVersion_config_object_check"
      CHECK (jsonb_typeof("config") = 'object')
);

CREATE UNIQUE INDEX "CapacityPolicyVersion_code_key"
  ON "CapacityPolicyVersion"("code");

CREATE TABLE "HealthPolicyActivation" (
    "id" UUID NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "policyVersionId" UUID NOT NULL,
    "actorUserId" UUID,
    "reason" VARCHAR(500) NOT NULL,
    "activatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HealthPolicyActivation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HealthPolicyActivation_reason_check"
      CHECK (char_length(btrim("reason")) BETWEEN 10 AND 500)
);

CREATE UNIQUE INDEX "HealthPolicyActivation_sequence_key"
  ON "HealthPolicyActivation"("sequence");
CREATE INDEX "HealthPolicyActivation_activatedAt_id_idx"
  ON "HealthPolicyActivation"("activatedAt", "id");
CREATE INDEX "HealthPolicyActivation_policyVersionId_activatedAt_idx"
  ON "HealthPolicyActivation"("policyVersionId", "activatedAt");
CREATE INDEX "HealthPolicyActivation_actorUserId_activatedAt_idx"
  ON "HealthPolicyActivation"("actorUserId", "activatedAt");

CREATE TABLE "CapacityPolicyActivation" (
    "id" UUID NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "policyVersionId" UUID NOT NULL,
    "actorUserId" UUID,
    "reason" VARCHAR(500) NOT NULL,
    "activatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CapacityPolicyActivation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CapacityPolicyActivation_reason_check"
      CHECK (char_length(btrim("reason")) BETWEEN 10 AND 500)
);

CREATE UNIQUE INDEX "CapacityPolicyActivation_sequence_key"
  ON "CapacityPolicyActivation"("sequence");
CREATE INDEX "CapacityPolicyActivation_activatedAt_id_idx"
  ON "CapacityPolicyActivation"("activatedAt", "id");
CREATE INDEX "CapacityPolicyActivation_policyVersionId_activatedAt_idx"
  ON "CapacityPolicyActivation"("policyVersionId", "activatedAt");
CREATE INDEX "CapacityPolicyActivation_actorUserId_activatedAt_idx"
  ON "CapacityPolicyActivation"("actorUserId", "activatedAt");

ALTER TABLE "HealthPolicyActivation"
  ADD CONSTRAINT "HealthPolicyActivation_policyVersionId_fkey"
  FOREIGN KEY ("policyVersionId") REFERENCES "HealthPolicyVersion"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HealthPolicyActivation"
  ADD CONSTRAINT "HealthPolicyActivation_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CapacityPolicyActivation"
  ADD CONSTRAINT "CapacityPolicyActivation_policyVersionId_fkey"
  FOREIGN KEY ("policyVersionId") REFERENCES "CapacityPolicyVersion"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CapacityPolicyActivation"
  ADD CONSTRAINT "CapacityPolicyActivation_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION protect_activated_operational_policy_version()
RETURNS trigger AS $$
DECLARE
  activation_table text := replace(TG_TABLE_NAME, 'Version', 'Activation');
  was_activated boolean;
BEGIN
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "policyVersionId" = $1)',
    TG_TABLE_SCHEMA,
    activation_table
  ) INTO was_activated USING OLD.id;
  IF was_activated THEN
    RAISE EXCEPTION '% is immutable after activation', TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_operational_policy_activation_change()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "HealthPolicyVersion_immutable"
BEFORE UPDATE OR DELETE ON "HealthPolicyVersion"
FOR EACH ROW EXECUTE FUNCTION protect_activated_operational_policy_version();
CREATE TRIGGER "CapacityPolicyVersion_immutable"
BEFORE UPDATE OR DELETE ON "CapacityPolicyVersion"
FOR EACH ROW EXECUTE FUNCTION protect_activated_operational_policy_version();
CREATE TRIGGER "HealthPolicyActivation_append_only"
BEFORE UPDATE OR DELETE ON "HealthPolicyActivation"
FOR EACH ROW EXECUTE FUNCTION reject_operational_policy_activation_change();
CREATE TRIGGER "CapacityPolicyActivation_append_only"
BEFORE UPDATE OR DELETE ON "CapacityPolicyActivation"
FOR EACH ROW EXECUTE FUNCTION reject_operational_policy_activation_change();

INSERT INTO "HealthPolicyVersion" ("id", "code", "config")
VALUES (
  '00000000-0000-4000-8000-000000000101',
  'beta-v1',
  '{
    "heartbeatIntervalSeconds": 30,
    "probeIntervalSeconds": 60,
    "probeTimeoutSeconds": 10,
    "probeSourceQuorum": 2,
    "degradedFailureCycles": 2,
    "excludeFailureCycles": 3,
    "recoverySuccessCycles": 5,
    "recoveryMinimumSeconds": 300,
    "cooldownSeconds": 600,
    "staleHeartbeatSeconds": 90,
    "resultFreshnessSeconds": 90,
    "mixedUnknownDegradedCycles": 2,
    "additionalProbeDelaySeconds": 15,
    "partialBlockedFailureCycles": 3,
    "blockedTargetNetworkQuorum": 2,
    "routeFailureClasses": ["DNS", "TCP_TLS", "VPN_HANDSHAKE", "TEST_TRAFFIC"]
  }'::jsonb
);

INSERT INTO "CapacityPolicyVersion" ("id", "code", "config")
VALUES (
  '00000000-0000-4000-8000-000000000102',
  'beta-v1',
  '{
    "runtimeFreshnessSeconds": 90,
    "warningUtilizationPercent": 65,
    "warningSustainSeconds": 600,
    "stopAssignmentUtilizationPercent": 80,
    "stopAssignmentSustainSeconds": 300,
    "criticalUtilizationPercent": 90,
    "criticalSustainSeconds": 300,
    "recoveryBelowUtilizationPercent": 60,
    "recoverySustainSeconds": 600,
    "diskWarningFreePercent": 20,
    "diskStopFreePercent": 10,
    "trafficSnapshotFreshnessSeconds": 86400,
    "trafficForecastMinimumElapsedSeconds": 86400,
    "trafficWarningForecastPercent": 80,
    "trafficStopActualPercent": 90,
    "trafficStopForecastPercent": 100,
    "overageOverrideMaximumSeconds": 86400,
    "plannedDrainDefaultSeconds": 86400,
    "plannedDrainMinimumSeconds": 3600,
    "plannedDrainMaximumSeconds": 259200,
    "promotionTargetSeconds": 120,
    "promotionHardTimeoutSeconds": 300,
    "reserveAggregateLoadPercent": 25,
    "reserveLargestNodeMultiplierPercent": 125,
    "reserveRequiresIndependentFailureDomain": true
  }'::jsonb
);

INSERT INTO "HealthPolicyActivation"
  ("id", "policyVersionId", "reason")
VALUES (
  '00000000-0000-4000-8000-000000000111',
  '00000000-0000-4000-8000-000000000101',
  'Initial closed-beta policy required by migration'
);

INSERT INTO "CapacityPolicyActivation"
  ("id", "policyVersionId", "reason")
VALUES (
  '00000000-0000-4000-8000-000000000112',
  '00000000-0000-4000-8000-000000000102',
  'Initial closed-beta policy required by migration'
);
