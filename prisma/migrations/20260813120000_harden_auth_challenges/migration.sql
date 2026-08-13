-- Existing local rows are preserved: legacy challenge rows receive an opaque,
-- non-secret launch identifier and remain subject to the new invariants.
ALTER TABLE "AuthChallenge" ADD COLUMN "launchId" VARCHAR(64);
UPDATE "AuthChallenge"
SET "launchId" = md5("id"::text || "createdAt"::text)
WHERE "launchId" IS NULL;
ALTER TABLE "AuthChallenge" ALTER COLUMN "launchId" SET NOT NULL;
CREATE UNIQUE INDEX "AuthChallenge_launchId_key" ON "AuthChallenge"("launchId");
CREATE INDEX "AuthChallenge_expiresAt_consumedAt_idx" ON "AuthChallenge"("expiresAt", "consumedAt");

ALTER TABLE "UserSession"
  ADD CONSTRAINT "UserSession_id_userId_key" UNIQUE ("id", "userId");
ALTER TABLE "AuthChallenge" DROP CONSTRAINT "AuthChallenge_sessionId_fkey";
ALTER TABLE "AuthChallenge"
  ADD CONSTRAINT "AuthChallenge_sessionId_userId_fkey"
  FOREIGN KEY ("sessionId", "userId") REFERENCES "UserSession"("id", "userId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthChallenge"
  ADD CONSTRAINT "AuthChallenge_consumption_complete"
  CHECK (("consumedAt" IS NULL AND "telegramReplayHash" IS NULL AND "sessionId" IS NULL AND "userId" IS NULL)
      OR ("consumedAt" IS NOT NULL AND "telegramReplayHash" IS NOT NULL AND "sessionId" IS NOT NULL AND "userId" IS NOT NULL));
ALTER TABLE "AuthChallenge"
  ADD CONSTRAINT "AuthChallenge_expiry_after_creation" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "AuthChallenge"
  ADD CONSTRAINT "AuthChallenge_consumed_after_creation" CHECK ("consumedAt" IS NULL OR "consumedAt" >= "createdAt");
