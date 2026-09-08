CREATE TYPE "ProbeSignalDisposition" AS ENUM ('ACCEPTED', 'REJECTED');
CREATE TYPE "ProbeSignalRejectionReason" AS ENUM (
  'POLICY_UNAVAILABLE',
  'ALREADY_CONSUMED',
  'UNAUTHENTICATED',
  'CONTROL_UNHEALTHY',
  'ROUTE_VERSION_MISMATCH',
  'CYCLE_MISMATCH',
  'OUTSIDE_FRESHNESS_WINDOW',
  'DUPLICATE_SOURCE',
  'DUPLICATE_INDEPENDENCE_KEY'
);

ALTER TABLE "AvailabilityDecision"
  ADD COLUMN "inputProbeResultIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "routeVersion" INTEGER;

UPDATE "AvailabilityDecision" AS decision
SET "inputProbeResultIds" = COALESCE(
  (
    SELECT jsonb_agg(link."probeResultId"::text ORDER BY link."probeResultId"::text)
    FROM "AvailabilityDecisionSignal" AS link
    WHERE link."availabilityDecisionId" = decision.id
  ),
  '[]'::jsonb
);

UPDATE "AvailabilityDecision" AS decision
SET "routeVersion" = COALESCE(
  (
    SELECT MIN(result."routeVersion")
    FROM "AvailabilityDecisionSignal" AS link
    INNER JOIN "ProbeResult" AS result ON result.id = link."probeResultId"
    WHERE link."availabilityDecisionId" = decision.id
  ),
  0
)
WHERE decision."cycleDecision" IS NOT NULL;

ALTER TABLE "AvailabilityDecision"
  ALTER COLUMN "inputProbeResultIds" DROP DEFAULT,
  DROP CONSTRAINT "AvailabilityDecision_cycle_check",
  ADD CONSTRAINT "AvailabilityDecision_input_probe_ids_check"
    CHECK (jsonb_typeof("inputProbeResultIds") = 'array'),
  ADD CONSTRAINT "AvailabilityDecision_cycle_check" CHECK (
    (("cycleDecision" IS NULL) = ("cycleStartedAt" IS NULL))
    AND (("cycleDecision" IS NULL) = ("routeVersion" IS NULL))
    AND ("routeVersion" IS NULL OR "routeVersion" >= 0)
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
  );

ALTER TABLE "AvailabilityDecisionSignal"
  ADD COLUMN disposition "ProbeSignalDisposition" NOT NULL DEFAULT 'ACCEPTED',
  ADD COLUMN "rejectionReason" "ProbeSignalRejectionReason",
  ADD CONSTRAINT "AvailabilityDecisionSignal_disposition_check" CHECK (
    (disposition = 'ACCEPTED' AND "rejectionReason" IS NULL)
    OR (disposition = 'REJECTED' AND "rejectionReason" IS NOT NULL)
  );
ALTER TABLE "AvailabilityDecisionSignal"
  ALTER COLUMN disposition DROP DEFAULT;

CREATE OR REPLACE FUNCTION validate_availability_decision_version()
RETURNS trigger AS $$
DECLARE
  current_version BIGINT;
  input_count INTEGER;
  unique_input_count INTEGER;
BEGIN
  SELECT state.version INTO current_version
  FROM "AvailabilityState" AS state
  WHERE state.id = NEW."availabilityStateId"
  FOR UPDATE;
  IF current_version IS NULL OR NEW."stateVersion" <> current_version + 1 THEN
    RAISE EXCEPTION 'AvailabilityDecision state version conflict';
  END IF;

  SELECT count(*), count(DISTINCT item.id)
    INTO input_count, unique_input_count
  FROM jsonb_array_elements_text(NEW."inputProbeResultIds") AS item(id);
  IF input_count <> unique_input_count THEN
    RAISE EXCEPTION 'AvailabilityDecision input probe IDs must be unique';
  END IF;
  IF NEW."cycleDecision" IS NOT NULL AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(NEW."signalIds") AS signal(id)
    WHERE NOT NEW."inputProbeResultIds" ? signal.id
  ) THEN
    RAISE EXCEPTION 'AvailabilityDecision contributing signal is not an input probe';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION protect_availability_state_scope()
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
      AND jsonb_array_length(decision."inputProbeResultIds") = (
        SELECT count(*)
        FROM "AvailabilityDecisionSignal" AS link
        WHERE link."availabilityDecisionId" = decision.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(decision."inputProbeResultIds") AS signal(id)
        WHERE NOT EXISTS (
          SELECT 1
          FROM "AvailabilityDecisionSignal" AS link
          WHERE link."availabilityDecisionId" = decision.id
            AND link."probeResultId"::text = signal.id
        )
      )
  ) INTO matching_decision;
  IF NOT matching_decision THEN
    RAISE EXCEPTION 'AvailabilityState update requires a matching decision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_availability_decision_signal_scope()
RETURNS trigger AS $$
DECLARE
  state_scope_kind "HealthScopeKind";
  state_scope_key VARCHAR(128);
  state_version BIGINT;
  decision_state_version BIGINT;
  decision_cycle_started_at TIMESTAMPTZ(6);
  decision_route_version INTEGER;
  decision_input_probe_ids JSONB;
  result_scope_kind "HealthScopeKind";
  result_scope_key VARCHAR(128);
  result_cycle_started_at TIMESTAMPTZ(6);
  result_route_version INTEGER;
BEGIN
  SELECT
    state."scopeKind",
    state."scopeKey",
    state.version,
    decision."stateVersion",
    decision."cycleStartedAt",
    decision."routeVersion",
    decision."inputProbeResultIds"
    INTO
      state_scope_kind,
      state_scope_key,
      state_version,
      decision_state_version,
      decision_cycle_started_at,
      decision_route_version,
      decision_input_probe_ids
  FROM "AvailabilityDecision" AS decision
  INNER JOIN "AvailabilityState" AS state
    ON state.id = decision."availabilityStateId"
  WHERE decision.id = NEW."availabilityDecisionId";

  SELECT
    result."scopeKind",
    result."scopeKey",
    result."cycleStartedAt",
    result."routeVersion"
    INTO
      result_scope_kind,
      result_scope_key,
      result_cycle_started_at,
      result_route_version
  FROM "ProbeResult" AS result
  WHERE result.id = NEW."probeResultId";

  IF state_scope_kind IS DISTINCT FROM result_scope_kind
     OR state_scope_key IS DISTINCT FROM result_scope_key THEN
    RAISE EXCEPTION 'AvailabilityDecision signal scope mismatch';
  END IF;
  IF NOT decision_input_probe_ids ? NEW."probeResultId"::text THEN
    RAISE EXCEPTION 'AvailabilityDecision signal is not declared as an input';
  END IF;
  IF NEW.disposition = 'ACCEPTED' AND (
    decision_cycle_started_at IS DISTINCT FROM result_cycle_started_at
    OR decision_route_version IS DISTINCT FROM result_route_version
  ) THEN
    RAISE EXCEPTION 'Accepted AvailabilityDecision signal cycle or route mismatch';
  END IF;
  IF state_version <> decision_state_version - 1 THEN
    RAISE EXCEPTION 'AvailabilityDecision signal set is already finalized';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
