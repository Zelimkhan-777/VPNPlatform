-- Emergency disable is a Node lifecycle status, distinct from endpoint/profile
-- availability QUARANTINED. Live grants must be revoked before entering it.
ALTER TYPE "NodeStatus" ADD VALUE 'QUARANTINED' AFTER 'DISABLED';

CREATE FUNCTION "prevent_live_grants_on_quarantined_node"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" <> 'REVOKED' AND EXISTS (
    SELECT 1
    FROM "Node"
    WHERE "id" = NEW."nodeId"
      AND "status" = 'QUARANTINED'
  ) THEN
    RAISE EXCEPTION 'Quarantined node cannot retain live access grants';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "NodeAccessGrant_prevent_live_on_quarantined"
BEFORE INSERT OR UPDATE OF "status", "nodeId" ON "NodeAccessGrant"
FOR EACH ROW EXECUTE FUNCTION "prevent_live_grants_on_quarantined_node"();

CREATE FUNCTION "prevent_quarantine_with_live_grants"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" = 'QUARANTINED'
    AND OLD."status" IS DISTINCT FROM 'QUARANTINED'
    AND EXISTS (
      SELECT 1
      FROM "NodeAccessGrant"
      WHERE "nodeId" = NEW."id"
        AND "status" <> 'REVOKED'
    ) THEN
    RAISE EXCEPTION 'Node cannot enter QUARANTINED while live access grants remain';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Node_prevent_quarantine_with_live_grants"
BEFORE UPDATE OF "status" ON "Node"
FOR EACH ROW EXECUTE FUNCTION "prevent_quarantine_with_live_grants"();
