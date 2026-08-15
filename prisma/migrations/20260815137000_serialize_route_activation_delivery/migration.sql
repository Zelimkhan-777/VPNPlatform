CREATE FUNCTION "lock_connection_route_node_for_activation"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."activationVersion" IS NOT NULL
    AND NEW."activationVersion" IS DISTINCT FROM OLD."activationVersion"
  THEN
    PERFORM 1
    FROM "Node"
    WHERE "id" = NEW."nodeId"
    FOR UPDATE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EndpointConnectionProfile_lock_node_for_activation"
  BEFORE UPDATE OF "activationVersion" ON "EndpointConnectionProfile"
  FOR EACH ROW EXECUTE FUNCTION "lock_connection_route_node_for_activation"();

CREATE OR REPLACE FUNCTION "validate_connection_route_activation_precedes_delivery"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."activationVersion" IS NULL
    OR NEW."activationVersion" IS NOT DISTINCT FROM OLD."activationVersion"
  THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "NodeConfigDelivery" AS delivery
    WHERE delivery."nodeId" = NEW."nodeId"
      AND delivery."targetVersion" = NEW."activationVersion"
  ) THEN
    RAISE EXCEPTION 'Connection route activation cannot use an already delivered version';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
