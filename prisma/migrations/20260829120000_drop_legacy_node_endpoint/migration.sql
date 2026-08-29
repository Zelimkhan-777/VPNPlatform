-- Node.endpoint was retained for one transition after Endpoint became the sole
-- source of network addresses. Refuse silent data loss if an unexpected legacy
-- value exists in any deployment.
DO $drop_legacy_node_endpoint$
BEGIN
  LOCK TABLE "Node" IN ACCESS EXCLUSIVE MODE;

  IF EXISTS (SELECT 1 FROM "Node" WHERE "endpoint" IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot drop Node.endpoint while non-null legacy values exist';
  END IF;

  ALTER TABLE "Node" DROP COLUMN "endpoint";
END
$drop_legacy_node_endpoint$;
