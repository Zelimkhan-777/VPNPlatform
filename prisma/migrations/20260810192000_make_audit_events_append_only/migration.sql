-- Audit records are evidence of control-plane actions and must remain append-only.
CREATE FUNCTION "AuditEvent_reject_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent is append-only';
END;
$$;

CREATE TRIGGER "AuditEvent_prevent_update_or_delete"
BEFORE UPDATE OR DELETE ON "AuditEvent"
FOR EACH ROW
EXECUTE FUNCTION "AuditEvent_reject_mutation"();
