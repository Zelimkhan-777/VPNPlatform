-- The initial constraint used an over-escaped IPv4 separator. Replace it
-- forward-only so previously deployed migration history remains immutable.
ALTER TABLE "Endpoint" DROP CONSTRAINT "Endpoint_host_format";

ALTER TABLE "Endpoint"
  ADD CONSTRAINT "Endpoint_host_format" CHECK (
    ("addressKind" = 'HOSTNAME' AND "host" ~ '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$')
    OR ("addressKind" = 'IPV4' AND "host" ~ '^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$')
    OR ("addressKind" = 'IPV6' AND "host" ~ '^[0-9A-Fa-f:]+$' AND position(':' in "host") > 0)
  );
