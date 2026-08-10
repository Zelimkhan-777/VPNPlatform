-- A node sync job may only reference an access grant assigned to the same node.
CREATE UNIQUE INDEX "NodeAccessGrant_id_nodeId_key" ON "NodeAccessGrant"("id", "nodeId");

ALTER TABLE "NodeSyncJob"
  DROP CONSTRAINT "NodeSyncJob_nodeAccessGrantId_fkey";

ALTER TABLE "NodeSyncJob"
  ADD CONSTRAINT "NodeSyncJob_nodeAccessGrantId_nodeId_fkey"
  FOREIGN KEY ("nodeAccessGrantId", "nodeId")
  REFERENCES "NodeAccessGrant"("id", "nodeId")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
