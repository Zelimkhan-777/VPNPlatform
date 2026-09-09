BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Node"
    WHERE length(btrim("locationLabel")) = 0
  ) THEN
    RAISE EXCEPTION 'Cannot backfill LocationPool from an empty Node.locationLabel';
  END IF;
  IF EXISTS (SELECT 1 FROM "Node")
     AND (
       NOT EXISTS (SELECT 1 FROM "HealthPolicyActivation")
       OR NOT EXISTS (SELECT 1 FROM "CapacityPolicyActivation")
     ) THEN
    RAISE EXCEPTION 'Cannot backfill LocationPool without active health and capacity policies';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TYPE "LocationPoolRole" AS ENUM ('SERVING', 'STANDBY');

CREATE TABLE "LocationPool" (
  id UUID NOT NULL,
  code VARCHAR(64) NOT NULL,
  "publicLabel" VARCHAR(128) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  "candidateLimit" INTEGER NOT NULL,
  "healthPolicyVersionId" UUID NOT NULL,
  "capacityPolicyVersionId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LocationPool_pkey" PRIMARY KEY (id),
  CONSTRAINT "LocationPool_code_check" CHECK (
    code ~ '^[a-z0-9][a-z0-9-]{2,63}$'
  ),
  CONSTRAINT "LocationPool_public_label_check" CHECK (
    length(btrim("publicLabel")) BETWEEN 1 AND 128
  ),
  CONSTRAINT "LocationPool_candidate_limit_check" CHECK (
    "candidateLimit" BETWEEN 1 AND 100
  )
);

CREATE TABLE "LocationPoolMembership" (
  id UUID NOT NULL,
  "locationPoolId" UUID NOT NULL,
  "nodeId" UUID NOT NULL,
  role "LocationPoolRole" NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LocationPoolMembership_pkey" PRIMARY KEY (id)
);

CREATE UNIQUE INDEX "LocationPool_code_key" ON "LocationPool"(code);
CREATE INDEX "LocationPool_enabled_publicLabel_idx"
  ON "LocationPool"(enabled, "publicLabel");
CREATE INDEX "LocationPool_healthPolicyVersionId_idx"
  ON "LocationPool"("healthPolicyVersionId");
CREATE INDEX "LocationPool_capacityPolicyVersionId_idx"
  ON "LocationPool"("capacityPolicyVersionId");
CREATE UNIQUE INDEX "LocationPoolMembership_nodeId_key"
  ON "LocationPoolMembership"("nodeId");
CREATE UNIQUE INDEX "LocationPoolMembership_locationPoolId_nodeId_key"
  ON "LocationPoolMembership"("locationPoolId", "nodeId");
CREATE INDEX "LocationPoolMembership_locationPoolId_role_idx"
  ON "LocationPoolMembership"("locationPoolId", role);

ALTER TABLE "LocationPool"
  ADD CONSTRAINT "LocationPool_healthPolicyVersionId_fkey"
  FOREIGN KEY ("healthPolicyVersionId") REFERENCES "HealthPolicyVersion"(id)
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LocationPool_capacityPolicyVersionId_fkey"
  FOREIGN KEY ("capacityPolicyVersionId") REFERENCES "CapacityPolicyVersion"(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LocationPoolMembership"
  ADD CONSTRAINT "LocationPoolMembership_locationPoolId_fkey"
  FOREIGN KEY ("locationPoolId") REFERENCES "LocationPool"(id)
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LocationPoolMembership_nodeId_fkey"
  FOREIGN KEY ("nodeId") REFERENCES "Node"(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_location_pool_policy_binding()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "HealthPolicyActivation"
    WHERE "policyVersionId" = NEW."healthPolicyVersionId"
  ) OR NOT EXISTS (
    SELECT 1 FROM "CapacityPolicyActivation"
    WHERE "policyVersionId" = NEW."capacityPolicyVersionId"
  ) THEN
    RAISE EXCEPTION 'LocationPool requires activated health and capacity policies';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LocationPool_validate_policy_binding"
BEFORE INSERT OR UPDATE OF "healthPolicyVersionId", "capacityPolicyVersionId"
ON "LocationPool"
FOR EACH ROW EXECUTE FUNCTION validate_location_pool_policy_binding();

CREATE FUNCTION protect_location_pool_identity()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LocationPool is append-preserved';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'LocationPool identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LocationPool_protect_identity"
BEFORE UPDATE OR DELETE ON "LocationPool"
FOR EACH ROW EXECUTE FUNCTION protect_location_pool_identity();

CREATE FUNCTION protect_location_pool_membership_identity()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LocationPoolMembership is append-preserved';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."nodeId" IS DISTINCT FROM OLD."nodeId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'LocationPoolMembership identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LocationPoolMembership_protect_identity"
BEFORE UPDATE OR DELETE ON "LocationPoolMembership"
FOR EACH ROW EXECUTE FUNCTION protect_location_pool_membership_identity();

INSERT INTO "LocationPool" (
  id,
  code,
  "publicLabel",
  enabled,
  "candidateLimit",
  "healthPolicyVersionId",
  "capacityPolicyVersionId"
)
SELECT DISTINCT ON (node."locationLabel")
  md5('location-pool:' || node."locationLabel")::uuid,
  'legacy-' || md5(node."locationLabel"),
  node."locationLabel",
  true,
  2,
  health_activation."policyVersionId",
  capacity_activation."policyVersionId"
FROM "Node" AS node
CROSS JOIN LATERAL (
  SELECT activation."policyVersionId"
  FROM "HealthPolicyActivation" AS activation
  ORDER BY activation.sequence DESC
  LIMIT 1
) AS health_activation
CROSS JOIN LATERAL (
  SELECT activation."policyVersionId"
  FROM "CapacityPolicyActivation" AS activation
  ORDER BY activation.sequence DESC
  LIMIT 1
) AS capacity_activation
ORDER BY node."locationLabel";

INSERT INTO "LocationPoolMembership" (
  id,
  "locationPoolId",
  "nodeId",
  role
)
SELECT
  md5('location-pool-membership:' || node.id::text)::uuid,
  md5('location-pool:' || node."locationLabel")::uuid,
  node.id,
  CASE
    WHEN node.status = 'PROVISIONING' THEN 'STANDBY'::"LocationPoolRole"
    ELSE 'SERVING'::"LocationPoolRole"
  END
FROM "Node" AS node;

COMMIT;
