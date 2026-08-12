-- Telegram Web App payloads and device issuance requests are one-time actions.
-- Store only keyed fingerprints; never persist plaintext payloads, keys or URLs.
ALTER TABLE "UserSession"
  ADD COLUMN "telegramReplayHash" CHAR(64);

CREATE UNIQUE INDEX "UserSession_telegramReplayHash_key"
  ON "UserSession"("telegramReplayHash");

ALTER TABLE "Device"
  ADD COLUMN "issuanceIdempotencyKeyHash" CHAR(64);

CREATE UNIQUE INDEX "Device_issuanceIdempotencyKeyHash_key"
  ON "Device"("issuanceIdempotencyKeyHash");
