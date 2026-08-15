-- Access-control sync stays open for healthy, draining, and available disabled
-- nodes. Returning to serving state requires reconciled desired/applied versions.
CREATE FUNCTION "prevent_unreconciled_return_to_healthy"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" = 'HEALTHY'
    AND OLD."status" IS DISTINCT FROM 'HEALTHY'
    AND NEW."desiredConfigVersion" > NEW."appliedConfigVersion" THEN
    RAISE EXCEPTION 'Node cannot return to HEALTHY until pending access updates are reconciled';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Node_prevent_unreconciled_return_to_healthy"
BEFORE UPDATE OF "status" ON "Node"
FOR EACH ROW EXECUTE FUNCTION "prevent_unreconciled_return_to_healthy"();
