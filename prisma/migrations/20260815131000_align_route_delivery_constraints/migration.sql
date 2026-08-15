-- Keep Prisma's declared relations drift-free while preserving the first
-- production migration exactly as it was applied.
ALTER TABLE "NodeSyncJob"
  RENAME CONSTRAINT "NodeSyncJob_route_fkey"
  TO "NodeSyncJob_routeEndpointId_routeConnectionProfileId_nodeI_fkey";

ALTER TABLE "NodeConfigDelivery"
  RENAME CONSTRAINT "NodeConfigDelivery_job_fkey"
  TO "NodeConfigDelivery_nodeSyncJobId_nodeId_targetVersion_fkey";
ALTER TABLE "NodeConfigDelivery"
  ADD CONSTRAINT "NodeConfigDelivery_nodeId_fkey"
  FOREIGN KEY ("nodeId") REFERENCES "Node"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NodeConfigAcknowledgement"
  RENAME CONSTRAINT "NodeConfigAcknowledgement_delivery_fkey"
  TO "NodeConfigAcknowledgement_nodeSyncJobId_snapshotHash_fkey";

-- Delivery rows are immutable while present, but may be removed later by an
-- explicit retention procedure once no acknowledgement references them.
DROP TRIGGER "NodeConfigDelivery_prevent_delete" ON "NodeConfigDelivery";
