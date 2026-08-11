-- Keep a durable, append-only proof that a node confirmed a configuration.
CREATE TABLE "NodeConfigAcknowledgement" (
    "id" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "nodeSyncJobId" UUID NOT NULL,
    "targetVersion" INTEGER NOT NULL,
    "acknowledgedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeConfigAcknowledgement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NodeConfigAcknowledgement_nodeSyncJobId_key"
  ON "NodeConfigAcknowledgement"("nodeSyncJobId");
CREATE UNIQUE INDEX "NodeConfigAcknowledgement_nodeId_targetVersion_key"
  ON "NodeConfigAcknowledgement"("nodeId", "targetVersion");
CREATE INDEX "NodeConfigAcknowledgement_nodeId_acknowledgedAt_idx"
  ON "NodeConfigAcknowledgement"("nodeId", "acknowledgedAt");

ALTER TABLE "NodeConfigAcknowledgement"
  ADD CONSTRAINT "NodeConfigAcknowledgement_nodeId_fkey"
  FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "NodeConfigAcknowledgement_nodeSyncJobId_fkey"
  FOREIGN KEY ("nodeSyncJobId") REFERENCES "NodeSyncJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "NodeConfigAcknowledgement_targetVersion_nonnegative"
  CHECK ("targetVersion" >= 0);

CREATE FUNCTION "validate_node_config_acknowledgement"()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "NodeSyncJob"
    WHERE "id" = NEW."nodeSyncJobId"
      AND "nodeId" = NEW."nodeId"
      AND "targetVersion" = NEW."targetVersion"
      AND "status" = 'SUCCEEDED'
  ) THEN
    RAISE EXCEPTION 'NodeConfigAcknowledgement requires a succeeded matching NodeSyncJob';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "NodeConfigAcknowledgement_validate"
BEFORE INSERT OR UPDATE ON "NodeConfigAcknowledgement"
FOR EACH ROW EXECUTE FUNCTION "validate_node_config_acknowledgement"();

CREATE FUNCTION "prevent_node_config_acknowledgement_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'NodeConfigAcknowledgement is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "NodeConfigAcknowledgement_prevent_update"
BEFORE UPDATE ON "NodeConfigAcknowledgement"
FOR EACH ROW EXECUTE FUNCTION "prevent_node_config_acknowledgement_mutation"();

CREATE TRIGGER "NodeConfigAcknowledgement_prevent_delete"
BEFORE DELETE ON "NodeConfigAcknowledgement"
FOR EACH ROW EXECUTE FUNCTION "prevent_node_config_acknowledgement_mutation"();

CREATE FUNCTION "enforce_node_applied_config_confirmation"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."appliedConfigVersion" < OLD."appliedConfigVersion" THEN
    RAISE EXCEPTION 'Node appliedConfigVersion cannot decrease';
  END IF;

  IF NEW."appliedConfigVersion" > OLD."appliedConfigVersion"
    AND NOT EXISTS (
      SELECT 1
      FROM "NodeConfigAcknowledgement"
      WHERE "nodeId" = NEW."id"
        AND "targetVersion" >= NEW."appliedConfigVersion"
    ) THEN
    RAISE EXCEPTION 'Node appliedConfigVersion requires an acknowledgement';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Node_enforce_applied_config_confirmation"
BEFORE UPDATE OF "appliedConfigVersion" ON "Node"
FOR EACH ROW EXECUTE FUNCTION "enforce_node_applied_config_confirmation"();
