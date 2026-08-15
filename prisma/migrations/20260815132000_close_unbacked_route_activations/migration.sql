-- Activations created by the legacy trigger were never connected to a
-- route-specific sync job or delivery. Keep them closed until explicitly
-- republished through production orchestration.
UPDATE "EndpointConnectionProfile" AS route
SET "activationVersion" = NULL
WHERE route."activationVersion" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "NodeSyncJob" AS job
    WHERE job."nodeId" = route."nodeId"
      AND job."routeEndpointId" = route."endpointId"
      AND job."routeConnectionProfileId" = route."connectionProfileId"
      AND job."targetVersion" = route."activationVersion"
      AND job."nodeAccessGrantId" IS NULL
  );

-- A node status transition is fail-closed in both directions. In particular,
-- returning a drained or disabled node to HEALTHY cannot restore an old
-- activation without a fresh rollout.
CREATE FUNCTION "close_node_route_activations"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    UPDATE "EndpointConnectionProfile"
    SET "activationVersion" = NULL
    WHERE "nodeId" = NEW."id"
      AND "activationVersion" IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Node_close_route_activations"
  AFTER UPDATE OF "status" ON "Node"
  FOR EACH ROW EXECUTE FUNCTION "close_node_route_activations"();

CREATE OR REPLACE FUNCTION "validate_connection_route_activation"()
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
    FROM "Node" AS node
    INNER JOIN "Endpoint" AS endpoint
      ON endpoint."id" = NEW."endpointId"
      AND endpoint."nodeId" = NEW."nodeId"
      AND endpoint."status" = 'ACTIVE'
    INNER JOIN "ConnectionProfile" AS profile
      ON profile."id" = NEW."connectionProfileId"
      AND profile."nodeId" = NEW."nodeId"
      AND profile."status" = 'ACTIVE'
    INNER JOIN "VlessTcpTlsPublicConfig" AS public_config
      ON public_config."connectionProfileId" = profile."id"
    WHERE node."id" = NEW."nodeId"
      AND node."status" = 'HEALTHY'
  ) THEN
    RAISE EXCEPTION 'Connection route activation requires eligible material';
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
