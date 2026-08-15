-- Route eligibility is no longer inferred from mapping insertion. A mapping is
-- closed until a production rollout assigns an activation version backed by a
-- route-specific sync job.
DROP TRIGGER "EndpointConnectionProfile_assign_rollout_version"
  ON "EndpointConnectionProfile";
DROP FUNCTION "assign_connection_route_rollout_version"();
DROP TRIGGER "EndpointConnectionProfile_prevent_update"
  ON "EndpointConnectionProfile";
DROP FUNCTION "prevent_connection_route_update"();

ALTER TABLE "EndpointConnectionProfile"
  RENAME COLUMN "introducedAtConfigVersion" TO "activationVersion";
ALTER INDEX "EndpointConnectionProfile_nodeId_introducedAtConfigVersion_idx"
  RENAME TO "EndpointConnectionProfile_nodeId_activationVersion_idx";
ALTER TABLE "EndpointConnectionProfile"
  RENAME CONSTRAINT "EndpointConnectionProfile_introduction_version_positive"
  TO "EndpointConnectionProfile_activation_version_positive";

-- Incomplete legacy routes have never delivered all material to a node. Keep
-- only versions that were already eligible before this migration.
UPDATE "EndpointConnectionProfile" AS route
SET "activationVersion" = NULL
FROM "Endpoint" AS endpoint, "ConnectionProfile" AS profile
WHERE endpoint."id" = route."endpointId"
  AND profile."id" = route."connectionProfileId"
  AND (
    endpoint."status" <> 'ACTIVE'
    OR profile."status" <> 'ACTIVE'
    OR NOT EXISTS (
      SELECT 1
      FROM "VlessTcpTlsPublicConfig" AS public_config
      WHERE public_config."connectionProfileId" = profile."id"
    )
  );

ALTER TABLE "EndpointConnectionProfile"
  ADD CONSTRAINT "EndpointConnectionProfile_route_node_key"
  UNIQUE ("endpointId", "connectionProfileId", "nodeId");

ALTER TABLE "NodeSyncJob"
  ADD COLUMN "routeEndpointId" UUID,
  ADD COLUMN "routeConnectionProfileId" UUID;

CREATE UNIQUE INDEX "NodeSyncJob_route_activation_key"
  ON "NodeSyncJob"(
    "routeEndpointId",
    "routeConnectionProfileId",
    "targetVersion"
  )
  WHERE "routeEndpointId" IS NOT NULL;
CREATE UNIQUE INDEX "NodeSyncJob_id_nodeId_targetVersion_key"
  ON "NodeSyncJob"("id", "nodeId", "targetVersion");

ALTER TABLE "NodeSyncJob"
  ADD CONSTRAINT "NodeSyncJob_route_fkey"
  FOREIGN KEY (
    "routeEndpointId",
    "routeConnectionProfileId",
    "nodeId"
  )
  REFERENCES "EndpointConnectionProfile"(
    "endpointId",
    "connectionProfileId",
    "nodeId"
  )
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "NodeSyncJob_exactly_one_sync_resource"
  CHECK (
    (
      "nodeAccessGrantId" IS NOT NULL
      AND "routeEndpointId" IS NULL
      AND "routeConnectionProfileId" IS NULL
    )
    OR
    (
      "nodeAccessGrantId" IS NULL
      AND "routeEndpointId" IS NOT NULL
      AND "routeConnectionProfileId" IS NOT NULL
    )
  ) NOT VALID;

CREATE TABLE "NodeConfigDelivery" (
  "id" UUID NOT NULL,
  "nodeId" UUID NOT NULL,
  "nodeSyncJobId" UUID NOT NULL,
  "targetVersion" INTEGER NOT NULL,
  "snapshotHash" CHAR(64) NOT NULL,
  "deliveredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NodeConfigDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NodeConfigDelivery_target_version_nonnegative"
    CHECK ("targetVersion" >= 0),
  CONSTRAINT "NodeConfigDelivery_snapshot_hash"
    CHECK ("snapshotHash" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "NodeConfigDelivery_job_hash_key"
  ON "NodeConfigDelivery"("nodeSyncJobId", "snapshotHash");
CREATE INDEX "NodeConfigDelivery_nodeId_targetVersion_idx"
  ON "NodeConfigDelivery"("nodeId", "targetVersion");

ALTER TABLE "NodeConfigDelivery"
  ADD CONSTRAINT "NodeConfigDelivery_job_fkey"
  FOREIGN KEY ("nodeSyncJobId", "nodeId", "targetVersion")
  REFERENCES "NodeSyncJob"("id", "nodeId", "targetVersion")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NodeConfigAcknowledgement"
  ADD COLUMN "snapshotHash" CHAR(64),
  ADD CONSTRAINT "NodeConfigAcknowledgement_snapshot_hash"
    CHECK (
      "snapshotHash" IS NULL
      OR "snapshotHash" ~ '^[a-f0-9]{64}$'
    );

CREATE UNIQUE INDEX "NodeConfigAcknowledgement_job_hash_key"
  ON "NodeConfigAcknowledgement"("nodeSyncJobId", "snapshotHash");

ALTER TABLE "NodeConfigAcknowledgement"
  ADD CONSTRAINT "NodeConfigAcknowledgement_delivery_fkey"
  FOREIGN KEY ("nodeSyncJobId", "snapshotHash")
  REFERENCES "NodeConfigDelivery"("nodeSyncJobId", "snapshotHash")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "validate_connection_route_activation"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."activationVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'Connection route activation requires production orchestration';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."endpointId" IS DISTINCT FROM OLD."endpointId"
    OR NEW."connectionProfileId" IS DISTINCT FROM OLD."connectionProfileId"
    OR NEW."nodeId" IS DISTINCT FROM OLD."nodeId"
  THEN
    RAISE EXCEPTION 'Connection route material is immutable';
  END IF;

  -- Clearing an activation is an immediate fail-closed operation.
  IF NEW."activationVersion" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."activationVersion" IS NOT DISTINCT FROM OLD."activationVersion" THEN
    RETURN NEW;
  END IF;

  IF OLD."activationVersion" IS NOT NULL
    AND NEW."activationVersion" <= OLD."activationVersion"
  THEN
    RAISE EXCEPTION 'Connection route activation version must increase';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "NodeSyncJob" AS job
    WHERE job."nodeId" = NEW."nodeId"
      AND job."routeEndpointId" = NEW."endpointId"
      AND job."routeConnectionProfileId" = NEW."connectionProfileId"
      AND job."targetVersion" = NEW."activationVersion"
      AND job."nodeAccessGrantId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Connection route activation requires a matching sync job';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EndpointConnectionProfile_validate_activation"
  BEFORE INSERT OR UPDATE ON "EndpointConnectionProfile"
  FOR EACH ROW EXECUTE FUNCTION "validate_connection_route_activation"();

CREATE FUNCTION "close_endpoint_route_activations"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'ACTIVE' AND NEW."status" <> 'ACTIVE' THEN
    UPDATE "EndpointConnectionProfile"
    SET "activationVersion" = NULL
    WHERE "endpointId" = NEW."id"
      AND "activationVersion" IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Endpoint_close_route_activations"
  AFTER UPDATE OF "status" ON "Endpoint"
  FOR EACH ROW EXECUTE FUNCTION "close_endpoint_route_activations"();

CREATE FUNCTION "close_profile_route_activations"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'ACTIVE' AND NEW."status" <> 'ACTIVE' THEN
    UPDATE "EndpointConnectionProfile"
    SET "activationVersion" = NULL
    WHERE "connectionProfileId" = NEW."id"
      AND "activationVersion" IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ConnectionProfile_close_route_activations"
  AFTER UPDATE OF "status" ON "ConnectionProfile"
  FOR EACH ROW EXECUTE FUNCTION "close_profile_route_activations"();

CREATE FUNCTION "close_routes_for_late_public_config"()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE "EndpointConnectionProfile"
  SET "activationVersion" = NULL
  WHERE "connectionProfileId" = NEW."connectionProfileId"
    AND "activationVersion" IS NOT NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "VlessTcpTlsPublicConfig_close_unpublished_routes"
  AFTER INSERT ON "VlessTcpTlsPublicConfig"
  FOR EACH ROW EXECUTE FUNCTION "close_routes_for_late_public_config"();

CREATE FUNCTION "prevent_node_config_delivery_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'NodeConfigDelivery is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "NodeConfigDelivery_prevent_update"
  BEFORE UPDATE ON "NodeConfigDelivery"
  FOR EACH ROW EXECUTE FUNCTION "prevent_node_config_delivery_mutation"();
CREATE TRIGGER "NodeConfigDelivery_prevent_delete"
  BEFORE DELETE ON "NodeConfigDelivery"
  FOR EACH ROW EXECUTE FUNCTION "prevent_node_config_delivery_mutation"();

CREATE OR REPLACE FUNCTION "validate_node_config_acknowledgement"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."snapshotHash" IS NULL OR NOT EXISTS (
    SELECT 1
    FROM "NodeSyncJob" AS job
    INNER JOIN "NodeConfigDelivery" AS delivery
      ON delivery."nodeSyncJobId" = job."id"
      AND delivery."nodeId" = job."nodeId"
      AND delivery."targetVersion" = job."targetVersion"
      AND delivery."snapshotHash" = NEW."snapshotHash"
    WHERE job."id" = NEW."nodeSyncJobId"
      AND job."nodeId" = NEW."nodeId"
      AND job."targetVersion" = NEW."targetVersion"
      AND job."status" = 'SUCCEEDED'
  ) THEN
    RAISE EXCEPTION 'NodeConfigAcknowledgement requires a delivered succeeded configuration';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
