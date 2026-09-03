BEGIN;

LOCK TABLE "User" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "Plan" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User"
    WHERE "role"::text = 'ADMIN'
  ) THEN
    RAISE EXCEPTION 'Legacy ADMIN users must be demoted with admin:demote-legacy-admin before migration';
  END IF;
END
$$;

ALTER TABLE "Plan" ADD COLUMN "durationDays" INTEGER;

DO $$
DECLARE
  plan_count BIGINT;
BEGIN
  SELECT count(*) INTO plan_count FROM "Plan";

  IF plan_count > 1 THEN
    RAISE EXCEPTION 'Cannot backfill Plan.durationDays: expected zero or one startup plan, found %', plan_count;
  END IF;

  IF plan_count = 1 THEN
    UPDATE "Plan" SET "durationDays" = 30 WHERE "durationDays" IS NULL;
  END IF;
END
$$;

ALTER TABLE "Plan"
  ALTER COLUMN "durationDays" SET NOT NULL,
  ADD CONSTRAINT "Plan_durationDays_check" CHECK ("durationDays" BETWEEN 1 AND 366),
  ADD CONSTRAINT "Plan_deviceLimit_check" CHECK ("deviceLimit" > 0);

ALTER TABLE "AuthChallenge"
  DROP CONSTRAINT "AuthChallenge_consumption_complete",
  ADD CONSTRAINT "AuthChallenge_consumption_complete" CHECK (
    ("consumedAt" IS NULL AND "telegramReplayHash" IS NULL AND "sessionId" IS NULL)
    OR (
      "consumedAt" IS NOT NULL
      AND "telegramReplayHash" IS NOT NULL
      AND "sessionId" IS NOT NULL
      AND "userId" IS NOT NULL
    )
  );

ALTER TYPE "UserRole" RENAME TO "UserRole_old";
CREATE TYPE "UserRole" AS ENUM ('CUSTOMER');
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User"
  ALTER COLUMN "role" TYPE "UserRole"
  USING ("role"::text::"UserRole");
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'CUSTOMER';
DROP TYPE "UserRole_old";

CREATE TYPE "AdminRole" AS ENUM ('OWNER', 'OPERATOR', 'SUPPORT', 'FINANCE', 'AUDITOR');
CREATE TYPE "AdminTotpCredentialStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');
CREATE TYPE "PendingLoginStatus" AS ENUM ('AWAITING_BOT_CONFIRM', 'BOT_CONFIRMED', 'CONSUMED');
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'CANCELLED');
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');

CREATE TABLE "Order" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "planId" UUID NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Order_amountMinor_check" CHECK ("amountMinor" >= 0)
);

CREATE TABLE "Payment" (
  "id" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "providerPaymentId" VARCHAR(128),
  "amountMinor" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Payment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Payment_amountMinor_check" CHECK ("amountMinor" >= 0)
);

CREATE TABLE "PromoCode" (
  "id" UUID NOT NULL,
  "planId" UUID NOT NULL,
  "secretHash" CHAR(64) NOT NULL,
  "campaignName" VARCHAR(128) NOT NULL,
  "durationDays" INTEGER NOT NULL,
  "maxUniqueUsers" INTEGER NOT NULL,
  "startsAt" TIMESTAMPTZ(6),
  "endsAt" TIMESTAMPTZ(6),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "comment" VARCHAR(512),
  "archivedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PromoCode_durationDays_check" CHECK ("durationDays" BETWEEN 1 AND 366),
  CONSTRAINT "PromoCode_maxUniqueUsers_check" CHECK ("maxUniqueUsers" > 0),
  CONSTRAINT "PromoCode_window_check" CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "startsAt" < "endsAt")
);

CREATE TABLE "PromoRedemption" (
  "id" UUID NOT NULL,
  "promoCodeId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "redeemedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PromoRedemption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PendingLogin" (
  "id" UUID NOT NULL,
  "challengeId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "telegramUserId" VARCHAR(32) NOT NULL,
  "pendingTokenHash" CHAR(64) NOT NULL,
  "confirmationCodeHash" CHAR(64) NOT NULL,
  "status" "PendingLoginStatus" NOT NULL DEFAULT 'AWAITING_BOT_CONFIRM',
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "confirmedAt" TIMESTAMPTZ(6),
  "consumedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PendingLogin_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PendingLogin_status_timestamps_check" CHECK (
    ("status" = 'AWAITING_BOT_CONFIRM' AND "confirmedAt" IS NULL AND "consumedAt" IS NULL)
    OR ("status" = 'BOT_CONFIRMED' AND "confirmedAt" IS NOT NULL AND "consumedAt" IS NULL)
    OR ("status" = 'CONSUMED' AND "confirmedAt" IS NOT NULL AND "consumedAt" IS NOT NULL)
  )
);

CREATE TABLE "AdminMembership" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "role" "AdminRole" NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AdminMembership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminSession" (
  "id" UUID NOT NULL,
  "membershipId" UUID NOT NULL,
  "tokenHash" CHAR(64) NOT NULL,
  "stepUpVerifiedAt" TIMESTAMPTZ(6),
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "revokedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminTotpCredential" (
  "id" UUID NOT NULL,
  "membershipId" UUID NOT NULL,
  "keyCiphertext" TEXT NOT NULL,
  "nonce" VARCHAR(128) NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "status" "AdminTotpCredentialStatus" NOT NULL DEFAULT 'PENDING',
  "lastVerifiedTimestep" BIGINT,
  "enrolledAt" TIMESTAMPTZ(6),
  "revokedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminTotpCredential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdminTotpCredential_keyVersion_check" CHECK ("keyVersion" > 0),
  CONSTRAINT "AdminTotpCredential_status_timestamps_check" CHECK (
    ("status" = 'PENDING' AND "enrolledAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'ACTIVE' AND "enrolledAt" IS NOT NULL AND "revokedAt" IS NULL)
    OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL)
  )
);

CREATE TABLE "AdminRecoveryCode" (
  "id" UUID NOT NULL,
  "credentialId" UUID NOT NULL,
  "codeHash" CHAR(64) NOT NULL,
  "consumedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminBootstrapState" (
  "id" INTEGER NOT NULL,
  "usedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AdminBootstrapState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdminBootstrapState_singleton_check" CHECK ("id" = 1)
);

CREATE TABLE "BotServicePrincipal" (
  "id" UUID NOT NULL,
  "name" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BotServicePrincipal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BotServiceCredential" (
  "id" UUID NOT NULL,
  "principalId" UUID NOT NULL,
  "keyCiphertext" TEXT NOT NULL,
  "nonce" VARCHAR(128) NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "revokedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BotServiceCredential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BotServiceCredential_keyVersion_check" CHECK ("keyVersion" > 0)
);

CREATE TABLE "BotRequestIdempotency" (
  "id" UUID NOT NULL,
  "principalId" UUID NOT NULL,
  "method" VARCHAR(16) NOT NULL,
  "path" VARCHAR(512) NOT NULL,
  "telegramUserId" VARCHAR(32) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "responseStatus" INTEGER,
  "responseBody" JSONB,
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "BotRequestIdempotency_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BotRequestIdempotency_response_check" CHECK (
    ("completedAt" IS NULL AND "responseStatus" IS NULL AND "responseBody" IS NULL)
    OR ("completedAt" IS NOT NULL AND "responseStatus" BETWEEN 100 AND 599)
  )
);

CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");
CREATE UNIQUE INDEX "Payment_orderId_key" ON "Payment"("orderId");
CREATE UNIQUE INDEX "Payment_providerPaymentId_key" ON "Payment"("providerPaymentId");
CREATE INDEX "Payment_orderId_status_idx" ON "Payment"("orderId", "status");
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");
CREATE UNIQUE INDEX "PromoCode_secretHash_key" ON "PromoCode"("secretHash");
CREATE INDEX "PromoCode_planId_isActive_idx" ON "PromoCode"("planId", "isActive");
CREATE INDEX "PromoCode_isActive_startsAt_endsAt_idx" ON "PromoCode"("isActive", "startsAt", "endsAt");
CREATE UNIQUE INDEX "PromoRedemption_promoCodeId_userId_key" ON "PromoRedemption"("promoCodeId", "userId");
CREATE INDEX "PromoRedemption_userId_redeemedAt_idx" ON "PromoRedemption"("userId", "redeemedAt");
CREATE UNIQUE INDEX "User_id_telegramUserId_key" ON "User"("id", "telegramUserId");
CREATE UNIQUE INDEX "AuthChallenge_id_userId_key" ON "AuthChallenge"("id", "userId");
CREATE UNIQUE INDEX "PendingLogin_pendingTokenHash_key" ON "PendingLogin"("pendingTokenHash");
CREATE INDEX "PendingLogin_challengeId_status_idx" ON "PendingLogin"("challengeId", "status");
CREATE INDEX "PendingLogin_telegramUserId_confirmationCodeHash_status_idx" ON "PendingLogin"("telegramUserId", "confirmationCodeHash", "status");
CREATE INDEX "PendingLogin_expiresAt_status_idx" ON "PendingLogin"("expiresAt", "status");
CREATE UNIQUE INDEX "AdminMembership_userId_key" ON "AdminMembership"("userId");
CREATE INDEX "AdminMembership_role_idx" ON "AdminMembership"("role");
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");
CREATE INDEX "AdminSession_membershipId_revokedAt_idx" ON "AdminSession"("membershipId", "revokedAt");
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");
CREATE INDEX "AdminTotpCredential_membershipId_status_idx" ON "AdminTotpCredential"("membershipId", "status");
CREATE UNIQUE INDEX "AdminTotpCredential_one_pending_per_membership" ON "AdminTotpCredential"("membershipId") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "AdminTotpCredential_one_active_per_membership" ON "AdminTotpCredential"("membershipId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "AdminRecoveryCode_codeHash_key" ON "AdminRecoveryCode"("codeHash");
CREATE INDEX "AdminRecoveryCode_credentialId_consumedAt_idx" ON "AdminRecoveryCode"("credentialId", "consumedAt");
CREATE UNIQUE INDEX "BotServicePrincipal_name_key" ON "BotServicePrincipal"("name");
CREATE INDEX "BotServiceCredential_principalId_revokedAt_idx" ON "BotServiceCredential"("principalId", "revokedAt");
CREATE UNIQUE INDEX "BotRequestIdempotency_scope_key" ON "BotRequestIdempotency"("principalId", "method", "path", "telegramUserId", "idempotencyKey");
CREATE INDEX "BotRequestIdempotency_principalId_createdAt_idx" ON "BotRequestIdempotency"("principalId", "createdAt");

ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PendingLogin" ADD CONSTRAINT "PendingLogin_challengeId_userId_fkey" FOREIGN KEY ("challengeId", "userId") REFERENCES "AuthChallenge"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PendingLogin" ADD CONSTRAINT "PendingLogin_userId_telegramUserId_fkey" FOREIGN KEY ("userId", "telegramUserId") REFERENCES "User"("id", "telegramUserId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdminMembership" ADD CONSTRAINT "AdminMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "AdminMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdminTotpCredential" ADD CONSTRAINT "AdminTotpCredential_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "AdminMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdminRecoveryCode" ADD CONSTRAINT "AdminRecoveryCode_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "AdminTotpCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BotServiceCredential" ADD CONSTRAINT "BotServiceCredential_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "BotServicePrincipal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BotRequestIdempotency" ADD CONSTRAINT "BotRequestIdempotency_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "BotServicePrincipal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthChallenge" ADD CONSTRAINT "AuthChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "prevent_last_owner_removal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."role" = 'OWNER' AND TG_OP = 'DELETE' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('admin-membership:last-owner', 0));

    IF NOT EXISTS (
      SELECT 1
      FROM "AdminMembership"
      WHERE "role" = 'OWNER'
        AND "id" <> OLD."id"
    ) THEN
      RAISE EXCEPTION 'Cannot remove or demote the last OWNER';
    END IF;
  END IF;

  IF OLD."role" = 'OWNER' AND TG_OP = 'UPDATE' AND NEW."role" <> 'OWNER' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('admin-membership:last-owner', 0));

    IF NOT EXISTS (
      SELECT 1
      FROM "AdminMembership"
      WHERE "role" = 'OWNER'
        AND "id" <> OLD."id"
    ) THEN
      RAISE EXCEPTION 'Cannot remove or demote the last OWNER';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AdminMembership_prevent_last_owner_removal"
BEFORE DELETE OR UPDATE OF "role" ON "AdminMembership"
FOR EACH ROW
EXECUTE FUNCTION "prevent_last_owner_removal"();

COMMIT;
