-- Legacy hashes cannot be converted to derivable credentials without their
-- plaintext input. A NULL version is intentionally fail-closed.
ALTER TABLE "NodeAccessGrant"
  ADD COLUMN "dataPlaneCredentialDerivationVersion" SMALLINT;

ALTER TABLE "NodeAccessGrant"
  ADD CONSTRAINT "NodeAccessGrant_data_plane_credential_derivation_version_positive"
  CHECK (
    "dataPlaneCredentialDerivationVersion" IS NULL
    OR "dataPlaneCredentialDerivationVersion" > 0
  );
