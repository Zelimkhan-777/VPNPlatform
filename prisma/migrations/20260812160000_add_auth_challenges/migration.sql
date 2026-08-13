CREATE TABLE "AuthChallenge" (
    "id" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "telegramReplayHash" CHAR(64),
    "sessionId" UUID,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" UUID,
    CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AuthChallenge_tokenHash_key" ON "AuthChallenge"("tokenHash");
CREATE UNIQUE INDEX "AuthChallenge_telegramReplayHash_key" ON "AuthChallenge"("telegramReplayHash");
CREATE UNIQUE INDEX "AuthChallenge_sessionId_key" ON "AuthChallenge"("sessionId");
CREATE INDEX "AuthChallenge_expiresAt_idx" ON "AuthChallenge"("expiresAt");
CREATE INDEX "AuthChallenge_userId_idx" ON "AuthChallenge"("userId");
ALTER TABLE "AuthChallenge" ADD CONSTRAINT "AuthChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthChallenge" ADD CONSTRAINT "AuthChallenge_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "UserSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
