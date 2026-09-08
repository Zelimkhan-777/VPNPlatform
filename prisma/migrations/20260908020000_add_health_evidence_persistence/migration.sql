CREATE TYPE "HealthScopeKind" AS ENUM (
  'PROFILE', 'ENDPOINT', 'NODE', 'PROVIDER_ASN'
);
CREATE TYPE "ProbeSourceStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "ProbeResultOutcome" AS ENUM (
  'SUCCESS', 'FAILURE', 'PROBE_SOURCE_FAILURE'
);
CREATE TYPE "ProbeFailureClass" AS ENUM (
  'DNS', 'TCP_TLS', 'VPN_HANDSHAKE', 'TEST_TRAFFIC'
);
CREATE TYPE "AvailabilityHealthStatus" AS ENUM (
  'UNKNOWN', 'HEALTHY', 'DEGRADED', 'PARTIALLY_BLOCKED',
  'QUARANTINED', 'BLOCKED', 'OFFLINE', 'DISABLED'
);
CREATE TYPE "AvailabilityCycleDecision" AS ENUM (
  'SUCCESS', 'FAILED', 'MIXED', 'UNKNOWN'
);
CREATE TYPE "AvailabilityDecisionReason" AS ENUM (
  'POLICY_UNAVAILABLE',
  'CRITICAL_TRUST_FAILURE',
  'STALE_HEARTBEAT',
  'FAILED_CYCLE_OBSERVED',
  'FAILURE_THRESHOLD_REACHED',
  'EXCLUSION_THRESHOLD_REACHED',
  'SUCCESS_CONFIRMED',
  'RECOVERY_PENDING',
  'RECOVERY_CONFIRMED',
  'MIXED_CYCLE',
  'UNKNOWN_CYCLE',
  'UNCERTAINTY_THRESHOLD_REACHED'
);

CREATE TABLE "ProbeSource" (
  "id" UUID NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "independenceKey" VARCHAR(128) NOT NULL,
  "status" "ProbeSourceStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ProbeSource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProbeSource_code_check"
    CHECK (char_length(btrim("code")) BETWEEN 1 AND 64),
  CONSTRAINT "ProbeSource_independence_key_check"
    CHECK (char_length(btrim("independenceKey")) BETWEEN 1 AND 128)
);
CREATE UNIQUE INDEX "ProbeSource_code_key" ON "ProbeSource"("code");
CREATE INDEX "ProbeSource_status_independenceKey_idx"
  ON "ProbeSource"("status", "independenceKey");

CREATE TABLE "ProbeResult" (
  "id" UUID NOT NULL,
  "probeSourceId" UUID NOT NULL,
  "sourceResultId" VARCHAR(128) NOT NULL,
  "sourceIndependenceKey" VARCHAR(128) NOT NULL,
  "scopeKind" "HealthScopeKind" NOT NULL,
  "scopeKey" VARCHAR(128) NOT NULL,
  "cycleStartedAt" TIMESTAMPTZ(6) NOT NULL,
  "routeVersion" INTEGER NOT NULL,
  "outcome" "ProbeResultOutcome" NOT NULL,
  "failureClass" "ProbeFailureClass",
  "controlHealthy" BOOLEAN NOT NULL,
  "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProbeResult_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProbeResult_source_result_id_check"
    CHECK (char_length(btrim("sourceResultId")) BETWEEN 1 AND 128),
  CONSTRAINT "ProbeResult_source_independence_key_check"
    CHECK (char_length(btrim("sourceIndependenceKey")) BETWEEN 1 AND 128),
  CONSTRAINT "ProbeResult_scope_key_check"
    CHECK (char_length(btrim("scopeKey")) BETWEEN 1 AND 128),
  CONSTRAINT "ProbeResult_route_version_check" CHECK ("routeVersion" >= 0),
  CONSTRAINT "ProbeResult_time_order_check"
    CHECK ("cycleStartedAt" <= "receivedAt"),
  CONSTRAINT "ProbeResult_failure_class_check" CHECK (
    ("outcome" = 'FAILURE' AND "failureClass" IS NOT NULL)
    OR ("outcome" <> 'FAILURE' AND "failureClass" IS NULL)
  )
);
CREATE UNIQUE INDEX "ProbeResult_probeSourceId_sourceResultId_key"
  ON "ProbeResult"("probeSourceId", "sourceResultId");
CREATE INDEX "ProbeResult_scopeKind_scopeKey_cycleStartedAt_idx"
  ON "ProbeResult"("scopeKind", "scopeKey", "cycleStartedAt");
CREATE INDEX "ProbeResult_receivedAt_idx" ON "ProbeResult"("receivedAt");
ALTER TABLE "ProbeResult"
  ADD CONSTRAINT "ProbeResult_probeSourceId_fkey"
  FOREIGN KEY ("probeSourceId") REFERENCES "ProbeSource"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AvailabilityState" (
  "id" UUID NOT NULL,
  "scopeKind" "HealthScopeKind" NOT NULL,
  "scopeKey" VARCHAR(128) NOT NULL,
  "status" "AvailabilityHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
  "excludedFromCandidates" BOOLEAN NOT NULL DEFAULT true,
  "consecutiveFailureCycles" INTEGER NOT NULL DEFAULT 0,
  "consecutiveRecoverySuccesses" INTEGER NOT NULL DEFAULT 0,
  "recoveryWindowStartedAt" TIMESTAMPTZ(6),
  "consecutiveUncertainCycles" INTEGER NOT NULL DEFAULT 0,
  "cooldownUntil" TIMESTAMPTZ(6),
  "version" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AvailabilityState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AvailabilityState_scope_key_check"
    CHECK (char_length(btrim("scopeKey")) BETWEEN 1 AND 128),
  CONSTRAINT "AvailabilityState_counters_check" CHECK (
    "consecutiveFailureCycles" >= 0
    AND "consecutiveRecoverySuccesses" >= 0
    AND "consecutiveUncertainCycles" >= 0
    AND "version" >= 0
  ),
  CONSTRAINT "AvailabilityState_healthy_candidate_check" CHECK (
    "status" <> 'HEALTHY' OR NOT "excludedFromCandidates"
  )
);
CREATE UNIQUE INDEX "AvailabilityState_scopeKind_scopeKey_key"
  ON "AvailabilityState"("scopeKind", "scopeKey");
CREATE INDEX "AvailabilityState_status_excludedFromCandidates_idx"
  ON "AvailabilityState"("status", "excludedFromCandidates");

CREATE TABLE "AvailabilityDecision" (
  "id" UUID NOT NULL,
  "idempotencyKey" CHAR(64) NOT NULL,
  "availabilityStateId" UUID NOT NULL,
  "stateVersion" BIGINT NOT NULL,
  "healthPolicyVersionId" UUID,
  "signalIds" JSONB NOT NULL,
  "decision" "AvailabilityHealthStatus" NOT NULL,
  "reason" "AvailabilityDecisionReason" NOT NULL,
  "excludedFromCandidates" BOOLEAN NOT NULL,
  "consecutiveFailureCycles" INTEGER NOT NULL,
  "consecutiveRecoverySuccesses" INTEGER NOT NULL,
  "recoveryWindowStartedAt" TIMESTAMPTZ(6),
  "consecutiveUncertainCycles" INTEGER NOT NULL,
  "cooldownUntil" TIMESTAMPTZ(6),
  "allowNewAssignments" BOOLEAN NOT NULL,
  "triggerReplacement" BOOLEAN NOT NULL,
  "triggerIncident" BOOLEAN NOT NULL,
  "cycleStartedAt" TIMESTAMPTZ(6),
  "cycleDecision" "AvailabilityCycleDecision",
  "failureClass" "ProbeFailureClass",
  "additionalProbeDueAt" TIMESTAMPTZ(6),
  "decidedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AvailabilityDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AvailabilityDecision_idempotency_key_check"
    CHECK ("idempotencyKey" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AvailabilityDecision_signal_ids_check"
    CHECK (jsonb_typeof("signalIds") = 'array'),
  CONSTRAINT "AvailabilityDecision_state_check" CHECK (
    "stateVersion" > 0
    AND "consecutiveFailureCycles" >= 0
    AND "consecutiveRecoverySuccesses" >= 0
    AND "consecutiveUncertainCycles" >= 0
    AND ("decision" <> 'HEALTHY' OR NOT "excludedFromCandidates")
    AND "allowNewAssignments" =
      ("decision" = 'HEALTHY' AND NOT "excludedFromCandidates")
    AND (NOT "triggerReplacement" OR "triggerIncident")
  ),
  CONSTRAINT "AvailabilityDecision_cycle_check" CHECK (
    (("cycleDecision" IS NULL) = ("cycleStartedAt" IS NULL))
    AND (
      ("cycleDecision" = 'FAILED' AND "failureClass" IS NOT NULL)
      OR ("cycleDecision" IS DISTINCT FROM 'FAILED' AND "failureClass" IS NULL)
    )
    AND (
      ("cycleDecision" = 'MIXED' AND "additionalProbeDueAt" IS NOT NULL)
      OR (
        "cycleDecision" IS DISTINCT FROM 'MIXED'
        AND "additionalProbeDueAt" IS NULL
      )
    )
  ),
  CONSTRAINT "AvailabilityDecision_policy_check" CHECK (
    "reason" IN ('POLICY_UNAVAILABLE', 'CRITICAL_TRUST_FAILURE')
    OR "healthPolicyVersionId" IS NOT NULL
  )
);
CREATE UNIQUE INDEX "AvailabilityDecision_idempotencyKey_key"
  ON "AvailabilityDecision"("idempotencyKey");
CREATE UNIQUE INDEX "AvailabilityDecision_availabilityStateId_stateVersion_key"
  ON "AvailabilityDecision"("availabilityStateId", "stateVersion");
CREATE INDEX "AvailabilityDecision_availabilityStateId_decidedAt_idx"
  ON "AvailabilityDecision"("availabilityStateId", "decidedAt");
CREATE INDEX "AvailabilityDecision_healthPolicyVersionId_decidedAt_idx"
  ON "AvailabilityDecision"("healthPolicyVersionId", "decidedAt");
ALTER TABLE "AvailabilityDecision"
  ADD CONSTRAINT "AvailabilityDecision_availabilityStateId_fkey"
  FOREIGN KEY ("availabilityStateId") REFERENCES "AvailabilityState"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AvailabilityDecision"
  ADD CONSTRAINT "AvailabilityDecision_healthPolicyVersionId_fkey"
  FOREIGN KEY ("healthPolicyVersionId") REFERENCES "HealthPolicyVersion"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AvailabilityDecisionSignal" (
  "availabilityDecisionId" UUID NOT NULL,
  "probeResultId" UUID NOT NULL,
  CONSTRAINT "AvailabilityDecisionSignal_pkey"
    PRIMARY KEY ("availabilityDecisionId", "probeResultId")
);
CREATE INDEX "AvailabilityDecisionSignal_probeResultId_idx"
  ON "AvailabilityDecisionSignal"("probeResultId");
ALTER TABLE "AvailabilityDecisionSignal"
  ADD CONSTRAINT "AvailabilityDecisionSignal_availabilityDecisionId_fkey"
  FOREIGN KEY ("availabilityDecisionId") REFERENCES "AvailabilityDecision"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AvailabilityDecisionSignal"
  ADD CONSTRAINT "AvailabilityDecisionSignal_probeResultId_fkey"
  FOREIGN KEY ("probeResultId") REFERENCES "ProbeResult"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_health_evidence_change()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION protect_availability_state_scope()
RETURNS trigger AS $$
DECLARE
  matching_decision boolean;
BEGIN
  IF NEW."scopeKind" IS DISTINCT FROM OLD."scopeKind"
     OR NEW."scopeKey" IS DISTINCT FROM OLD."scopeKey" THEN
    RAISE EXCEPTION 'AvailabilityState scope is immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'AvailabilityState version must advance by one decision';
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM "AvailabilityDecision" AS decision
    WHERE decision."availabilityStateId" = OLD.id
      AND decision."stateVersion" = NEW.version
      AND decision.decision = NEW.status
      AND decision."excludedFromCandidates" = NEW."excludedFromCandidates"
      AND decision."consecutiveFailureCycles" = NEW."consecutiveFailureCycles"
      AND decision."consecutiveRecoverySuccesses" = NEW."consecutiveRecoverySuccesses"
      AND decision."recoveryWindowStartedAt"
        IS NOT DISTINCT FROM NEW."recoveryWindowStartedAt"
      AND decision."consecutiveUncertainCycles" = NEW."consecutiveUncertainCycles"
      AND decision."cooldownUntil" IS NOT DISTINCT FROM NEW."cooldownUntil"
      AND (
        decision."cycleDecision" IS NULL
        OR (
          jsonb_array_length(decision."signalIds") = (
            SELECT count(*)
            FROM "AvailabilityDecisionSignal" AS link
            WHERE link."availabilityDecisionId" = decision.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(decision."signalIds") AS signal(id)
            WHERE NOT EXISTS (
              SELECT 1
              FROM "AvailabilityDecisionSignal" AS link
              WHERE link."availabilityDecisionId" = decision.id
                AND link."probeResultId"::text = signal.id
            )
          )
        )
      )
  ) INTO matching_decision;
  IF NOT matching_decision THEN
    RAISE EXCEPTION 'AvailabilityState update requires a matching decision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_initial_availability_state()
RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'UNKNOWN'
     OR NOT NEW."excludedFromCandidates"
     OR NEW."consecutiveFailureCycles" <> 0
     OR NEW."consecutiveRecoverySuccesses" <> 0
     OR NEW."recoveryWindowStartedAt" IS NOT NULL
     OR NEW."consecutiveUncertainCycles" <> 0
     OR NEW."cooldownUntil" IS NOT NULL
     OR NEW.version <> 0 THEN
    RAISE EXCEPTION 'AvailabilityState must start fail-closed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_availability_decision_version()
RETURNS trigger AS $$
DECLARE
  current_version BIGINT;
BEGIN
  SELECT state.version INTO current_version
  FROM "AvailabilityState" AS state
  WHERE state.id = NEW."availabilityStateId"
  FOR UPDATE;
  IF current_version IS NULL OR NEW."stateVersion" <> current_version + 1 THEN
    RAISE EXCEPTION 'AvailabilityDecision state version conflict';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_availability_decision_signal_scope()
RETURNS trigger AS $$
DECLARE
  state_scope_kind "HealthScopeKind";
  state_scope_key VARCHAR(128);
  state_version BIGINT;
  decision_state_version BIGINT;
  decision_cycle_started_at TIMESTAMPTZ(6);
  decision_signal_ids JSONB;
  result_scope_kind "HealthScopeKind";
  result_scope_key VARCHAR(128);
  result_cycle_started_at TIMESTAMPTZ(6);
BEGIN
  SELECT
    state."scopeKind",
    state."scopeKey",
    state.version,
    decision."stateVersion",
    decision."cycleStartedAt",
    decision."signalIds"
    INTO
      state_scope_kind,
      state_scope_key,
      state_version,
      decision_state_version,
      decision_cycle_started_at,
      decision_signal_ids
  FROM "AvailabilityDecision" AS decision
  INNER JOIN "AvailabilityState" AS state
    ON state.id = decision."availabilityStateId"
  WHERE decision.id = NEW."availabilityDecisionId";

  SELECT result."scopeKind", result."scopeKey", result."cycleStartedAt"
    INTO result_scope_kind, result_scope_key, result_cycle_started_at
  FROM "ProbeResult" AS result
  WHERE result.id = NEW."probeResultId";

  IF state_scope_kind IS DISTINCT FROM result_scope_kind
     OR state_scope_key IS DISTINCT FROM result_scope_key
     OR decision_cycle_started_at IS DISTINCT FROM result_cycle_started_at THEN
    RAISE EXCEPTION 'AvailabilityDecision signal scope or cycle mismatch';
  END IF;
  IF NOT decision_signal_ids ? NEW."probeResultId"::text THEN
    RAISE EXCEPTION 'AvailabilityDecision signal is not declared by the decision';
  END IF;
  IF state_version <> decision_state_version - 1 THEN
    RAISE EXCEPTION 'AvailabilityDecision signal set is already finalized';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProbeResult_append_only"
BEFORE UPDATE OR DELETE ON "ProbeResult"
FOR EACH ROW EXECUTE FUNCTION reject_health_evidence_change();
CREATE TRIGGER "AvailabilityDecision_append_only"
BEFORE UPDATE OR DELETE ON "AvailabilityDecision"
FOR EACH ROW EXECUTE FUNCTION reject_health_evidence_change();
CREATE TRIGGER "AvailabilityDecision_version_check"
BEFORE INSERT ON "AvailabilityDecision"
FOR EACH ROW EXECUTE FUNCTION validate_availability_decision_version();
CREATE TRIGGER "AvailabilityDecisionSignal_append_only"
BEFORE UPDATE OR DELETE ON "AvailabilityDecisionSignal"
FOR EACH ROW EXECUTE FUNCTION reject_health_evidence_change();
CREATE TRIGGER "AvailabilityState_initial_fail_closed"
BEFORE INSERT ON "AvailabilityState"
FOR EACH ROW EXECUTE FUNCTION validate_initial_availability_state();
CREATE TRIGGER "AvailabilityState_scope_immutable"
BEFORE UPDATE ON "AvailabilityState"
FOR EACH ROW EXECUTE FUNCTION protect_availability_state_scope();
CREATE TRIGGER "AvailabilityDecisionSignal_scope_check"
BEFORE INSERT ON "AvailabilityDecisionSignal"
FOR EACH ROW EXECUTE FUNCTION validate_availability_decision_signal_scope();
