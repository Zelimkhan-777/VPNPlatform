ALTER TABLE "VlessTcpTlsPublicConfig"
  DROP CONSTRAINT "VlessTcpTlsPublicConfig_displayName_safe",
  DROP CONSTRAINT "VlessTcpTlsPublicConfig_tlsServerName_hostname";

ALTER TABLE "VlessTcpTlsPublicConfig"
  ADD CONSTRAINT "VlessTcpTlsPublicConfig_displayName_safe"
    CHECK (
      char_length("displayName") BETWEEN 1 AND 128
      AND "displayName" !~ '[[:cntrl:]]'
    ),
  ADD CONSTRAINT "VlessTcpTlsPublicConfig_tlsServerName_hostname"
    CHECK (
      char_length("tlsServerName") BETWEEN 1 AND 253
      AND "tlsServerName" ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$'
    );
