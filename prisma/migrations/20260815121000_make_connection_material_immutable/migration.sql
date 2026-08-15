CREATE FUNCTION "prevent_published_endpoint_material_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    NEW."nodeId" IS DISTINCT FROM OLD."nodeId"
    OR NEW."host" IS DISTINCT FROM OLD."host"
    OR NEW."addressKind" IS DISTINCT FROM OLD."addressKind"
    OR NEW."port" IS DISTINCT FROM OLD."port"
  ) AND EXISTS (
    SELECT 1
    FROM "EndpointConnectionProfile"
    WHERE "endpointId" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'Published Endpoint connection material is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Endpoint_prevent_published_material_mutation"
  BEFORE UPDATE ON "Endpoint"
  FOR EACH ROW EXECUTE FUNCTION "prevent_published_endpoint_material_mutation"();

CREATE FUNCTION "prevent_published_profile_material_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    NEW."nodeId" IS DISTINCT FROM OLD."nodeId"
    OR NEW."profileKey" IS DISTINCT FROM OLD."profileKey"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."protocolKind" IS DISTINCT FROM OLD."protocolKind"
    OR NEW."transportKind" IS DISTINCT FROM OLD."transportKind"
    OR NEW."securityKind" IS DISTINCT FROM OLD."securityKind"
    OR NEW."clientCompatibility" IS DISTINCT FROM OLD."clientCompatibility"
  ) AND (
    EXISTS (
      SELECT 1
      FROM "EndpointConnectionProfile"
      WHERE "connectionProfileId" = OLD."id"
    )
    OR EXISTS (
      SELECT 1
      FROM "VlessTcpTlsPublicConfig"
      WHERE "connectionProfileId" = OLD."id"
    )
  ) THEN
    RAISE EXCEPTION 'Published ConnectionProfile connection material is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ConnectionProfile_prevent_published_material_mutation"
  BEFORE UPDATE ON "ConnectionProfile"
  FOR EACH ROW EXECUTE FUNCTION "prevent_published_profile_material_mutation"();

CREATE OR REPLACE FUNCTION "VlessTcpTlsPublicConfig_validate_profile"()
RETURNS trigger AS $$
DECLARE
  profile_record "ConnectionProfile"%ROWTYPE;
BEGIN
  SELECT *
    INTO profile_record
    FROM "ConnectionProfile"
    WHERE "id" = NEW."connectionProfileId"
    FOR UPDATE;

  IF NOT FOUND
    OR profile_record."protocolKind" <> 'VLESS'
    OR profile_record."transportKind" <> 'TCP'
    OR profile_record."securityKind" <> 'TLS'
    OR profile_record."clientCompatibility" <> 'HAPP'
  THEN
    RAISE EXCEPTION 'VlessTcpTlsPublicConfig requires VLESS/TCP/TLS/HAPP profile';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "VlessTcpTlsPublicConfig_prevent_delete"
  BEFORE DELETE ON "VlessTcpTlsPublicConfig"
  FOR EACH ROW EXECUTE FUNCTION "VlessTcpTlsPublicConfig_prevent_update"();
