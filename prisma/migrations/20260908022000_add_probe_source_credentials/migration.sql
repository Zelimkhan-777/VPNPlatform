CREATE TABLE "ProbeSourceCredential" (
  "id" UUID NOT NULL,
  "probeSourceId" UUID NOT NULL,
  "secretHash" CHAR(64) NOT NULL,
  "revokedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProbeSourceCredential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProbeSourceCredential_secret_hash_check"
    CHECK ("secretHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ProbeSourceCredential_revocation_order_check"
    CHECK ("revokedAt" IS NULL OR "revokedAt" >= "createdAt")
);

CREATE UNIQUE INDEX "ProbeSourceCredential_secretHash_key"
  ON "ProbeSourceCredential"("secretHash");
CREATE UNIQUE INDEX "ProbeSourceCredential_one_active_per_source_key"
  ON "ProbeSourceCredential"("probeSourceId")
  WHERE "revokedAt" IS NULL;
CREATE INDEX "ProbeSourceCredential_probeSourceId_revokedAt_idx"
  ON "ProbeSourceCredential"("probeSourceId", "revokedAt");

ALTER TABLE "ProbeSourceCredential"
  ADD CONSTRAINT "ProbeSourceCredential_probeSourceId_fkey"
  FOREIGN KEY ("probeSourceId") REFERENCES "ProbeSource"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
