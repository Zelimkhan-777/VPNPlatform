-- Endpoint is a replaceable network address. It deliberately remains separate
-- from the lifecycle of the physical Node.
CREATE TYPE "EndpointAddressKind" AS ENUM ('HOSTNAME', 'IPV4', 'IPV6');
CREATE TYPE "EndpointStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "ConnectionProfileStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED');
CREATE TYPE "ConnectionProtocolKind" AS ENUM ('VLESS', 'WIREGUARD');
CREATE TYPE "ConnectionTransportKind" AS ENUM ('TCP', 'WEBSOCKET', 'GRPC');
CREATE TYPE "ConnectionSecurityKind" AS ENUM ('NONE', 'TLS', 'REALITY');
CREATE TYPE "ClientCompatibilityKind" AS ENUM ('HAPP');

CREATE TABLE "Endpoint" (
    "id" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "host" VARCHAR(253) NOT NULL,
    "addressKind" "EndpointAddressKind" NOT NULL,
    "port" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" "EndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Endpoint_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Endpoint_port_in_range" CHECK ("port" BETWEEN 1 AND 65535),
    CONSTRAINT "Endpoint_priority_non_negative" CHECK ("priority" >= 0),
    CONSTRAINT "Endpoint_host_format" CHECK (
      ("addressKind" = 'HOSTNAME' AND "host" ~ '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$')
      OR ("addressKind" = 'IPV4' AND "host" ~ '^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$')
      OR ("addressKind" = 'IPV6' AND "host" ~ '^[0-9A-Fa-f:]+$' AND position(':' in "host") > 0)
    )
);

CREATE TABLE "ConnectionProfile" (
    "id" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "profileKey" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ConnectionProfileStatus" NOT NULL DEFAULT 'DRAFT',
    "protocolKind" "ConnectionProtocolKind" NOT NULL,
    "transportKind" "ConnectionTransportKind" NOT NULL,
    "securityKind" "ConnectionSecurityKind" NOT NULL,
    "clientCompatibility" "ClientCompatibilityKind" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ConnectionProfile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ConnectionProfile_version_positive" CHECK ("version" >= 1),
    CONSTRAINT "ConnectionProfile_priority_non_negative" CHECK ("priority" >= 0)
);

CREATE TABLE "EndpointConnectionProfile" (
    "endpointId" UUID NOT NULL,
    "connectionProfileId" UUID NOT NULL,
    "nodeId" UUID NOT NULL,

    CONSTRAINT "EndpointConnectionProfile_pkey" PRIMARY KEY ("endpointId", "connectionProfileId")
);

CREATE UNIQUE INDEX "Endpoint_id_nodeId_key" ON "Endpoint"("id", "nodeId");
CREATE INDEX "Endpoint_nodeId_status_priority_idx" ON "Endpoint"("nodeId", "status", "priority");
CREATE UNIQUE INDEX "ConnectionProfile_id_nodeId_key" ON "ConnectionProfile"("id", "nodeId");
CREATE UNIQUE INDEX "ConnectionProfile_nodeId_profileKey_version_key" ON "ConnectionProfile"("nodeId", "profileKey", "version");
CREATE UNIQUE INDEX "ConnectionProfile_one_active_version_per_key" ON "ConnectionProfile"("nodeId", "profileKey") WHERE "status" = 'ACTIVE';
CREATE INDEX "ConnectionProfile_nodeId_status_priority_idx" ON "ConnectionProfile"("nodeId", "status", "priority");
CREATE INDEX "EndpointConnectionProfile_nodeId_idx" ON "EndpointConnectionProfile"("nodeId");

ALTER TABLE "Endpoint"
  ADD CONSTRAINT "Endpoint_nodeId_fkey"
  FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ConnectionProfile"
  ADD CONSTRAINT "ConnectionProfile_nodeId_fkey"
  FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EndpointConnectionProfile"
  ADD CONSTRAINT "EndpointConnectionProfile_endpointId_nodeId_fkey"
  FOREIGN KEY ("endpointId", "nodeId") REFERENCES "Endpoint"("id", "nodeId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EndpointConnectionProfile"
  ADD CONSTRAINT "EndpointConnectionProfile_connectionProfileId_nodeId_fkey"
  FOREIGN KEY ("connectionProfileId", "nodeId") REFERENCES "ConnectionProfile"("id", "nodeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Node.endpoint is intentionally retained for one transition. Its old free-form
-- representation cannot be parsed losslessly into host/address-kind/port, and
-- new route selection never reads it. This prevents dual sources of truth while
-- preserving all existing legacy values for a later explicit migration.
COMMENT ON COLUMN "Node"."endpoint" IS 'Deprecated legacy endpoint. Retained without backfill; Endpoint is the sole source for route selection.';
