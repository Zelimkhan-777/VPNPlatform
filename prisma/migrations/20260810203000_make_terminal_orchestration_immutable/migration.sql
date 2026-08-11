-- A completed work item is final evidence for later acknowledgements and
-- retries. It may be deleted by retention policy, but it must not be changed.
CREATE FUNCTION "reject_terminal_node_sync_job_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" IN ('SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'NodeSyncJob terminal state is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "NodeSyncJob_prevent_terminal_update"
BEFORE UPDATE ON "NodeSyncJob"
FOR EACH ROW EXECUTE FUNCTION "reject_terminal_node_sync_job_mutation"();

CREATE FUNCTION "reject_terminal_outbox_event_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" IN ('PUBLISHED', 'FAILED') THEN
    RAISE EXCEPTION 'OutboxEvent terminal state is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OutboxEvent_prevent_terminal_update"
BEFORE UPDATE ON "OutboxEvent"
FOR EACH ROW EXECUTE FUNCTION "reject_terminal_outbox_event_mutation"();
