ALTER TABLE "EndpointConnectionProfile"
  ADD COLUMN "lastActivationVersion" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "EndpointConnectionProfile_last_activation_nonnegative"
    CHECK ("lastActivationVersion" >= 0);

UPDATE "EndpointConnectionProfile" AS route
SET "lastActivationVersion" = GREATEST(
  COALESCE(route."activationVersion", 0),
  COALESCE((
    SELECT MAX(job."targetVersion")
    FROM "NodeSyncJob" AS job
    WHERE job."nodeId" = route."nodeId"
      AND job."routeEndpointId" = route."endpointId"
      AND job."routeConnectionProfileId" = route."connectionProfileId"
  ), 0)
);

CREATE OR REPLACE FUNCTION "validate_connection_route_activation"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."activationVersion" IS NOT NULL
      OR NEW."lastActivationVersion" <> 0
    THEN
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
    NEW."lastActivationVersion" := OLD."lastActivationVersion";
    RETURN NEW;
  END IF;

  IF NEW."activationVersion" IS NOT DISTINCT FROM OLD."activationVersion" THEN
    NEW."lastActivationVersion" := OLD."lastActivationVersion";
    RETURN NEW;
  END IF;

  IF NEW."activationVersion" <= OLD."lastActivationVersion" THEN
    RAISE EXCEPTION 'Connection route activation version must increase beyond every prior activation';
  END IF;

  NEW."lastActivationVersion" := NEW."activationVersion";

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
