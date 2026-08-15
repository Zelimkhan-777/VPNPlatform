ALTER TABLE "VlessTcpTlsPublicConfig"
  ADD CONSTRAINT "VlessTcpTlsPublicConfig_tlsServerName_hostname"
  CHECK (
    "tlsServerName" !~ '[^A-Za-z0-9.-]'
    AND "tlsServerName" !~ '^[-.]|[-.]$|[.][.]'
  );

CREATE OR REPLACE FUNCTION "VlessTcpTlsPublicConfig_prevent_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'VlessTcpTlsPublicConfig is immutable; create a new ConnectionProfile version';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "VlessTcpTlsPublicConfig_prevent_update"
  BEFORE UPDATE ON "VlessTcpTlsPublicConfig"
  FOR EACH ROW EXECUTE FUNCTION "VlessTcpTlsPublicConfig_prevent_update"();
