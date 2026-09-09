CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'RESOLVED');
CREATE TYPE "IncidentTimelineEventKind" AS ENUM (
  'OPENED',
  'OPERATION_CREATED',
  'RESOLVED'
);
CREATE TYPE "NodeOperationType" AS ENUM (
  'RECHECK',
  'RETRY_DELIVERY',
  'RECONCILE',
  'APPLY_LAST_KNOWN_GOOD',
  'DRAIN',
  'PROMOTE_STANDBY',
  'ROTATE_AGENT_CREDENTIAL',
  'RESTORE_AFTER_VERIFY',
  'MIGRATE',
  'RETIRE'
);
CREATE TYPE "NodeOperationStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED'
);
CREATE TYPE "NodeOperationInitiatorKind" AS ENUM (
  'SERVICE_PRINCIPAL',
  'ADMIN'
);

CREATE TABLE "Incident" (
  id UUID NOT NULL,
  "availabilityDecisionId" UUID NOT NULL,
  "scopeKind" "HealthScopeKind" NOT NULL,
  "scopeKey" VARCHAR(128) NOT NULL,
  status "IncidentStatus" NOT NULL DEFAULT 'OPEN',
  "openedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMPTZ(6),
  CONSTRAINT "Incident_pkey" PRIMARY KEY (id),
  CONSTRAINT "Incident_status_timestamps_check" CHECK (
    (status = 'OPEN' AND "resolvedAt" IS NULL)
    OR (status = 'RESOLVED' AND "resolvedAt" IS NOT NULL)
  ),
  CONSTRAINT "Incident_resolution_order_check" CHECK (
    "resolvedAt" IS NULL OR "resolvedAt" >= "openedAt"
  )
);

CREATE TABLE "NodeOperation" (
  id UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "availabilityDecisionId" UUID NOT NULL,
  "healthPolicyVersionId" UUID NOT NULL,
  "idempotencyKey" CHAR(64) NOT NULL,
  type "NodeOperationType" NOT NULL,
  status "NodeOperationStatus" NOT NULL DEFAULT 'PENDING',
  "scopeKind" "HealthScopeKind" NOT NULL,
  "scopeKey" VARCHAR(128) NOT NULL,
  "initiatorKind" "NodeOperationInitiatorKind" NOT NULL,
  "servicePrincipal" VARCHAR(128),
  "actorUserId" UUID,
  reason VARCHAR(500) NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL,
  "startedAt" TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "failureCode" VARCHAR(128),
  "safeResult" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NodeOperation_pkey" PRIMARY KEY (id),
  CONSTRAINT "NodeOperation_idempotency_key_check"
    CHECK ("idempotencyKey" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "NodeOperation_reason_check"
    CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  CONSTRAINT "NodeOperation_attempts_check"
    CHECK ("maxAttempts" BETWEEN 1 AND 100 AND attempts BETWEEN 0 AND "maxAttempts"),
  CONSTRAINT "NodeOperation_initiator_check" CHECK (
    (
      "initiatorKind" = 'SERVICE_PRINCIPAL'
      AND "servicePrincipal" IS NOT NULL
      AND "actorUserId" IS NULL
    ) OR (
      "initiatorKind" = 'ADMIN'
      AND "servicePrincipal" IS NULL
      AND "actorUserId" IS NOT NULL
    )
  ),
  CONSTRAINT "NodeOperation_lifecycle_check" CHECK (
    (
      status = 'PENDING'
      AND "startedAt" IS NULL
      AND "completedAt" IS NULL
      AND "failureCode" IS NULL
      AND "safeResult" IS NULL
    ) OR (
      status = 'RUNNING'
      AND "startedAt" IS NOT NULL
      AND "completedAt" IS NULL
      AND "failureCode" IS NULL
      AND "safeResult" IS NULL
    ) OR (
      status = 'SUCCEEDED'
      AND "startedAt" IS NOT NULL
      AND "completedAt" IS NOT NULL
      AND "failureCode" IS NULL
    ) OR (
      status = 'FAILED'
      AND "startedAt" IS NOT NULL
      AND "completedAt" IS NOT NULL
      AND "failureCode" IS NOT NULL
    )
  ),
  CONSTRAINT "NodeOperation_timestamp_order_check" CHECK (
    ("startedAt" IS NULL OR "startedAt" >= "createdAt")
    AND ("completedAt" IS NULL OR "completedAt" >= "startedAt")
  )
);

CREATE TABLE "IncidentTimelineEvent" (
  id BIGSERIAL NOT NULL,
  "incidentId" UUID NOT NULL,
  kind "IncidentTimelineEventKind" NOT NULL,
  "nodeOperationId" UUID,
  "safeMetadata" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IncidentTimelineEvent_pkey" PRIMARY KEY (id),
  CONSTRAINT "IncidentTimelineEvent_shape_check" CHECK (
    (kind = 'OPERATION_CREATED' AND "nodeOperationId" IS NOT NULL)
    OR (kind IN ('OPENED', 'RESOLVED') AND "nodeOperationId" IS NULL)
  )
);

CREATE UNIQUE INDEX "Incident_availabilityDecisionId_key"
  ON "Incident"("availabilityDecisionId");
CREATE INDEX "Incident_status_openedAt_idx" ON "Incident"(status, "openedAt");
CREATE INDEX "Incident_scopeKind_scopeKey_status_idx"
  ON "Incident"("scopeKind", "scopeKey", status);
CREATE UNIQUE INDEX "NodeOperation_idempotencyKey_key"
  ON "NodeOperation"("idempotencyKey");
CREATE UNIQUE INDEX "NodeOperation_availabilityDecisionId_type_key"
  ON "NodeOperation"("availabilityDecisionId", type);
CREATE INDEX "NodeOperation_incidentId_status_createdAt_idx"
  ON "NodeOperation"("incidentId", status, "createdAt");
CREATE INDEX "NodeOperation_status_createdAt_idx"
  ON "NodeOperation"(status, "createdAt");
CREATE INDEX "NodeOperation_actorUserId_createdAt_idx"
  ON "NodeOperation"("actorUserId", "createdAt");
CREATE UNIQUE INDEX "IncidentTimelineEvent_nodeOperationId_key"
  ON "IncidentTimelineEvent"("nodeOperationId");
CREATE UNIQUE INDEX "IncidentTimelineEvent_one_opened_key"
  ON "IncidentTimelineEvent"("incidentId") WHERE kind = 'OPENED';
CREATE UNIQUE INDEX "IncidentTimelineEvent_one_resolved_key"
  ON "IncidentTimelineEvent"("incidentId") WHERE kind = 'RESOLVED';
CREATE INDEX "IncidentTimelineEvent_incidentId_id_idx"
  ON "IncidentTimelineEvent"("incidentId", id);

ALTER TABLE "Incident"
  ADD CONSTRAINT "Incident_availabilityDecisionId_fkey"
  FOREIGN KEY ("availabilityDecisionId") REFERENCES "AvailabilityDecision"(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NodeOperation"
  ADD CONSTRAINT "NodeOperation_incidentId_fkey"
  FOREIGN KEY ("incidentId") REFERENCES "Incident"(id)
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "NodeOperation_availabilityDecisionId_fkey"
  FOREIGN KEY ("availabilityDecisionId") REFERENCES "AvailabilityDecision"(id)
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "NodeOperation_healthPolicyVersionId_fkey"
  FOREIGN KEY ("healthPolicyVersionId") REFERENCES "HealthPolicyVersion"(id)
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "NodeOperation_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IncidentTimelineEvent"
  ADD CONSTRAINT "IncidentTimelineEvent_incidentId_fkey"
  FOREIGN KEY ("incidentId") REFERENCES "Incident"(id)
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "IncidentTimelineEvent_nodeOperationId_fkey"
  FOREIGN KEY ("nodeOperationId") REFERENCES "NodeOperation"(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_incident_decision_binding()
RETURNS trigger AS $$
DECLARE
  expected_scope_kind "HealthScopeKind";
  expected_scope_key VARCHAR(128);
  should_trigger boolean;
BEGIN
  SELECT state."scopeKind", state."scopeKey", decision."triggerIncident"
    INTO expected_scope_kind, expected_scope_key, should_trigger
  FROM "AvailabilityDecision" AS decision
  INNER JOIN "AvailabilityState" AS state
    ON state.id = decision."availabilityStateId"
  WHERE decision.id = NEW."availabilityDecisionId";
  IF expected_scope_kind IS NULL OR should_trigger IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Incident requires a triggering availability decision';
  END IF;
  IF NEW."scopeKind" IS DISTINCT FROM expected_scope_kind
     OR NEW."scopeKey" IS DISTINCT FROM expected_scope_key THEN
    RAISE EXCEPTION 'Incident scope must match its availability decision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Incident_validate_decision_binding"
BEFORE INSERT ON "Incident"
FOR EACH ROW EXECUTE FUNCTION validate_incident_decision_binding();

CREATE FUNCTION protect_incident_identity_and_lifecycle()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Incident is append-preserved';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."availabilityDecisionId" IS DISTINCT FROM OLD."availabilityDecisionId"
     OR NEW."scopeKind" IS DISTINCT FROM OLD."scopeKind"
     OR NEW."scopeKey" IS DISTINCT FROM OLD."scopeKey"
     OR NEW."openedAt" IS DISTINCT FROM OLD."openedAt" THEN
    RAISE EXCEPTION 'Incident identity is immutable';
  END IF;
  IF OLD.status = 'RESOLVED' OR NEW.status NOT IN ('OPEN', 'RESOLVED') THEN
    RAISE EXCEPTION 'Incident terminal state is immutable';
  END IF;
  IF NEW.status = 'RESOLVED' AND NOT EXISTS (
    SELECT 1 FROM "IncidentTimelineEvent" AS event
    WHERE event."incidentId" = OLD.id AND event.kind = 'RESOLVED'
  ) THEN
    RAISE EXCEPTION 'Incident resolution requires a timeline event';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Incident_protect_identity_and_lifecycle"
BEFORE UPDATE OR DELETE ON "Incident"
FOR EACH ROW EXECUTE FUNCTION protect_incident_identity_and_lifecycle();

CREATE FUNCTION validate_node_operation_binding()
RETURNS trigger AS $$
DECLARE
  incident_decision_id UUID;
  incident_status "IncidentStatus";
  expected_scope_kind "HealthScopeKind";
  expected_scope_key VARCHAR(128);
  expected_policy_id UUID;
  should_replace boolean;
BEGIN
  SELECT "availabilityDecisionId", status
    INTO incident_decision_id, incident_status
  FROM "Incident" WHERE id = NEW."incidentId" FOR UPDATE;
  SELECT
    state."scopeKind",
    state."scopeKey",
    decision."healthPolicyVersionId",
    decision."triggerReplacement"
    INTO expected_scope_kind, expected_scope_key, expected_policy_id, should_replace
  FROM "AvailabilityDecision" AS decision
  INNER JOIN "AvailabilityState" AS state
    ON state.id = decision."availabilityStateId"
  WHERE decision.id = NEW."availabilityDecisionId";
  IF incident_status IS DISTINCT FROM 'OPEN'
     OR incident_decision_id IS DISTINCT FROM NEW."availabilityDecisionId"
     OR should_replace IS DISTINCT FROM true
     OR expected_policy_id IS NULL THEN
    RAISE EXCEPTION 'NodeOperation requires an open incident, triggering decision and policy';
  END IF;
  IF NEW."healthPolicyVersionId" IS DISTINCT FROM expected_policy_id
     OR NEW."scopeKind" IS DISTINCT FROM expected_scope_kind
     OR NEW."scopeKey" IS DISTINCT FROM expected_scope_key THEN
    RAISE EXCEPTION 'NodeOperation policy or scope does not match its decision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "NodeOperation_validate_binding"
BEFORE INSERT ON "NodeOperation"
FOR EACH ROW EXECUTE FUNCTION validate_node_operation_binding();

CREATE FUNCTION protect_node_operation_lifecycle()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'NodeOperation is append-preserved';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."incidentId" IS DISTINCT FROM OLD."incidentId"
     OR NEW."availabilityDecisionId" IS DISTINCT FROM OLD."availabilityDecisionId"
     OR NEW."healthPolicyVersionId" IS DISTINCT FROM OLD."healthPolicyVersionId"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW."scopeKind" IS DISTINCT FROM OLD."scopeKind"
     OR NEW."scopeKey" IS DISTINCT FROM OLD."scopeKey"
     OR NEW."initiatorKind" IS DISTINCT FROM OLD."initiatorKind"
     OR NEW."servicePrincipal" IS DISTINCT FROM OLD."servicePrincipal"
     OR NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId"
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW."maxAttempts" IS DISTINCT FROM OLD."maxAttempts"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'NodeOperation identity is immutable';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'NodeOperation attempts cannot decrease';
  END IF;
  IF OLD.status = 'PENDING' AND NEW.status NOT IN ('PENDING', 'RUNNING', 'FAILED') THEN
    RAISE EXCEPTION 'Invalid NodeOperation transition';
  END IF;
  IF OLD.status = 'RUNNING' AND NEW.status NOT IN ('RUNNING', 'SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'Invalid NodeOperation transition';
  END IF;
  IF OLD.status IN ('SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'NodeOperation terminal state is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "NodeOperation_protect_lifecycle"
BEFORE UPDATE OR DELETE ON "NodeOperation"
FOR EACH ROW EXECUTE FUNCTION protect_node_operation_lifecycle();

CREATE FUNCTION validate_incident_timeline_event()
RETURNS trigger AS $$
DECLARE
  operation_incident_id UUID;
  incident_status "IncidentStatus";
BEGIN
  SELECT status INTO incident_status
  FROM "Incident" WHERE id = NEW."incidentId" FOR UPDATE;
  IF incident_status IS NULL THEN
    RAISE EXCEPTION 'Incident timeline requires an incident';
  END IF;
  IF NEW."nodeOperationId" IS NOT NULL THEN
    SELECT "incidentId" INTO operation_incident_id
    FROM "NodeOperation" WHERE id = NEW."nodeOperationId";
    IF operation_incident_id IS DISTINCT FROM NEW."incidentId" THEN
      RAISE EXCEPTION 'Incident timeline operation mismatch';
    END IF;
  END IF;
  IF NEW.kind IN ('OPENED', 'OPERATION_CREATED') AND incident_status <> 'OPEN' THEN
    RAISE EXCEPTION 'Incident activity event requires an open incident';
  END IF;
  IF NEW.kind = 'RESOLVED' AND (
    incident_status <> 'OPEN' OR EXISTS (
      SELECT 1 FROM "NodeOperation" AS operation
      WHERE operation."incidentId" = NEW."incidentId"
        AND operation.status NOT IN ('SUCCEEDED', 'FAILED')
    )
  ) THEN
    RAISE EXCEPTION 'Incident resolution requires terminal operations';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "IncidentTimelineEvent_validate"
BEFORE INSERT ON "IncidentTimelineEvent"
FOR EACH ROW EXECUTE FUNCTION validate_incident_timeline_event();

CREATE FUNCTION resolve_incident_from_timeline()
RETURNS trigger AS $$
BEGIN
  IF NEW.kind = 'RESOLVED' THEN
    UPDATE "Incident"
    SET status = 'RESOLVED', "resolvedAt" = NEW."createdAt"
    WHERE id = NEW."incidentId" AND status = 'OPEN';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Incident resolution transition failed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "IncidentTimelineEvent_resolve_incident"
AFTER INSERT ON "IncidentTimelineEvent"
FOR EACH ROW EXECUTE FUNCTION resolve_incident_from_timeline();

CREATE FUNCTION protect_incident_timeline_event()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Incident timeline is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "IncidentTimelineEvent_append_only"
BEFORE UPDATE OR DELETE ON "IncidentTimelineEvent"
FOR EACH ROW EXECUTE FUNCTION protect_incident_timeline_event();
