ALTER TABLE "EndpointConnectionProfile"
  ADD COLUMN "introducedAtConfigVersion" INTEGER,
  ADD CONSTRAINT "EndpointConnectionProfile_introduction_version_positive"
    CHECK ("introducedAtConfigVersion" IS NULL OR "introducedAtConfigVersion" >= 1);

CREATE INDEX "EndpointConnectionProfile_nodeId_introducedAtConfigVersion_idx"
  ON "EndpointConnectionProfile"("nodeId", "introducedAtConfigVersion");

-- Existing mappings intentionally remain NULL. Their introduction was never
-- acknowledged, so the subscription feed must treat them as legacy and closed.
CREATE FUNCTION "assign_connection_route_rollout_version"()
RETURNS TRIGGER AS $$
DECLARE
  current_desired_version INTEGER;
BEGIN
  IF NEW."introducedAtConfigVersion" IS NOT NULL THEN
    RAISE EXCEPTION 'Connection route rollout version is assigned by PostgreSQL';
  END IF;

  SELECT "desiredConfigVersion"
    INTO current_desired_version
    FROM "Node"
    WHERE "id" = NEW."nodeId"
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Connection route requires an existing node';
  END IF;

  -- Lock both material rows before publication. This serializes publication
  -- with direct mutation regardless of which transaction starts first.
  PERFORM 1
    FROM "Endpoint"
    WHERE "id" = NEW."endpointId" AND "nodeId" = NEW."nodeId"
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Connection route endpoint does not belong to node';
  END IF;

  PERFORM 1
    FROM "ConnectionProfile"
    WHERE "id" = NEW."connectionProfileId" AND "nodeId" = NEW."nodeId"
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Connection route profile does not belong to node';
  END IF;

  NEW."introducedAtConfigVersion" := current_desired_version + 1;
  UPDATE "Node"
    SET "desiredConfigVersion" = NEW."introducedAtConfigVersion",
        "updatedAt" = clock_timestamp()
    WHERE "id" = NEW."nodeId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EndpointConnectionProfile_assign_rollout_version"
  BEFORE INSERT ON "EndpointConnectionProfile"
  FOR EACH ROW EXECUTE FUNCTION "assign_connection_route_rollout_version"();

CREATE FUNCTION "prevent_connection_route_update"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Connection route is immutable; delete and publish a new rollout version';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EndpointConnectionProfile_prevent_update"
  BEFORE UPDATE ON "EndpointConnectionProfile"
  FOR EACH ROW EXECUTE FUNCTION "prevent_connection_route_update"();
