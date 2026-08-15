CREATE FUNCTION "validate_connection_route_activation_is_unapplied"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."activationVersion" IS NULL
    OR NEW."activationVersion" IS NOT DISTINCT FROM OLD."activationVersion"
  THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Node" AS node
    WHERE node."id" = NEW."nodeId"
      AND node."appliedConfigVersion" >= NEW."activationVersion"
  ) THEN
    RAISE EXCEPTION 'Connection route activation must be newer than the applied node configuration';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EndpointConnectionProfile_validate_activation_is_unapplied"
  AFTER UPDATE OF "activationVersion" ON "EndpointConnectionProfile"
  FOR EACH ROW EXECUTE FUNCTION "validate_connection_route_activation_is_unapplied"();
