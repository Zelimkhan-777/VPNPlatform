-- Agent contact and independent data-plane health checks have different meanings.
ALTER TABLE "Node"
  ADD COLUMN "lastHeartbeatAt" TIMESTAMPTZ(6);
