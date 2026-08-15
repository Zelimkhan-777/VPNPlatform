CREATE TABLE "VlessTcpTlsPublicConfig" (
  "id" uuid NOT NULL,
  "connectionProfileId" uuid NOT NULL,
  "tlsServerName" varchar(253) NOT NULL,
  "displayName" varchar(128) NOT NULL,
  "createdAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VlessTcpTlsPublicConfig_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VlessTcpTlsPublicConfig_connectionProfileId_key" UNIQUE ("connectionProfileId"),
  CONSTRAINT "VlessTcpTlsPublicConfig_displayName_safe" CHECK ("displayName" !~ '[\\r\\n[:cntrl:]]')
);
ALTER TABLE "VlessTcpTlsPublicConfig" ADD CONSTRAINT "VlessTcpTlsPublicConfig_connectionProfileId_fkey" FOREIGN KEY ("connectionProfileId") REFERENCES "ConnectionProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE OR REPLACE FUNCTION "VlessTcpTlsPublicConfig_validate_profile"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ConnectionProfile" WHERE "id" = NEW."connectionProfileId" AND "protocolKind" = 'VLESS' AND "transportKind" = 'TCP' AND "securityKind" = 'TLS' AND "clientCompatibility" = 'HAPP') THEN RAISE EXCEPTION 'VlessTcpTlsPublicConfig requires VLESS/TCP/TLS/HAPP profile'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "VlessTcpTlsPublicConfig_validate_profile" BEFORE INSERT OR UPDATE ON "VlessTcpTlsPublicConfig" FOR EACH ROW EXECUTE FUNCTION "VlessTcpTlsPublicConfig_validate_profile"();
