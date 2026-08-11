-- Each node may have one active opaque credential. The plaintext secret is
-- never stored: only its HMAC-SHA-256 hash is persisted.
CREATE TABLE "NodeAgentCredential" (
    "id" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "secretHash" CHAR(64) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeAgentCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NodeAgentCredential_secretHash_key"
  ON "NodeAgentCredential"("secretHash");
CREATE UNIQUE INDEX "NodeAgentCredential_one_active_per_node"
  ON "NodeAgentCredential"("nodeId")
  WHERE "revokedAt" IS NULL;
CREATE INDEX "NodeAgentCredential_nodeId_revokedAt_idx"
  ON "NodeAgentCredential"("nodeId", "revokedAt");

ALTER TABLE "NodeAgentCredential"
  ADD CONSTRAINT "NodeAgentCredential_nodeId_fkey"
  FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
