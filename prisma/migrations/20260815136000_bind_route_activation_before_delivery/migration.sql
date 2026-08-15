UPDATE "EndpointConnectionProfile" AS route
SET "activationVersion" = NULL
WHERE route."activationVersion" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "NodeSyncJob" AS job
    INNER JOIN "OutboxEvent" AS event
      ON event."topic" = 'node-sync.requested'
      AND event."aggregateType" = 'ConnectionRoute'
      AND event."aggregateId" = route."endpointId"
      AND event."payload" = jsonb_build_object(
        'routeEndpointId', route."endpointId"::text,
        'routeConnectionProfileId', route."connectionProfileId"::text,
        'nodeSyncJobId', job."id"::text,
        'targetVersion', job."targetVersion"
      )
    WHERE job."nodeId" = route."nodeId"
      AND job."routeEndpointId" = route."endpointId"
      AND job."routeConnectionProfileId" = route."connectionProfileId"
      AND job."targetVersion" = route."activationVersion"
      AND job."nodeAccessGrantId" IS NULL
  );

CREATE OR REPLACE FUNCTION "validate_connection_route_activation_outbox"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."activationVersion" IS NULL
    OR NEW."activationVersion" IS NOT DISTINCT FROM OLD."activationVersion"
  THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "NodeSyncJob" AS job
    INNER JOIN "OutboxEvent" AS event
      ON event."topic" = 'node-sync.requested'
      AND event."aggregateType" = 'ConnectionRoute'
      AND event."aggregateId" = NEW."endpointId"
      AND event."payload" = jsonb_build_object(
        'routeEndpointId', NEW."endpointId"::text,
        'routeConnectionProfileId', NEW."connectionProfileId"::text,
        'nodeSyncJobId', job."id"::text,
        'targetVersion', job."targetVersion"
      )
    WHERE job."nodeId" = NEW."nodeId"
      AND job."routeEndpointId" = NEW."endpointId"
      AND job."routeConnectionProfileId" = NEW."connectionProfileId"
      AND job."targetVersion" = NEW."activationVersion"
      AND job."nodeAccessGrantId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Connection route activation requires a matching outbox event';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "validate_connection_route_activation_precedes_delivery"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."activationVersion" IS NULL
    OR NEW."activationVersion" IS NOT DISTINCT FROM OLD."activationVersion"
  THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "NodeSyncJob" AS job
    INNER JOIN "NodeConfigDelivery" AS delivery
      ON delivery."nodeSyncJobId" = job."id"
      AND delivery."nodeId" = job."nodeId"
      AND delivery."targetVersion" = job."targetVersion"
    WHERE job."nodeId" = NEW."nodeId"
      AND job."routeEndpointId" = NEW."endpointId"
      AND job."routeConnectionProfileId" = NEW."connectionProfileId"
      AND job."targetVersion" = NEW."activationVersion"
  ) THEN
    RAISE EXCEPTION 'Connection route activation cannot use an already delivered version';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EndpointConnectionProfile_validate_activation_precedes_delivery"
  AFTER UPDATE OF "activationVersion" ON "EndpointConnectionProfile"
  FOR EACH ROW EXECUTE FUNCTION "validate_connection_route_activation_precedes_delivery"();
