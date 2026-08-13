-- The composite relation already enforces AuthChallenge ownership. Remove only
-- the redundant direct User FK so Prisma models the database relation without
-- proposing replacement of the composite invariant.
ALTER TABLE "AuthChallenge" DROP CONSTRAINT "AuthChallenge_userId_fkey";
DROP INDEX "AuthChallenge_sessionId_key";
CREATE UNIQUE INDEX "AuthChallenge_sessionId_userId_key"
  ON "AuthChallenge"("sessionId", "userId");
