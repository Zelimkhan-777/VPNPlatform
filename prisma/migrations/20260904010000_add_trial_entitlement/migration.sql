BEGIN;

CREATE TABLE "TrialCampaign" (
  "id" UUID NOT NULL,
  "planId" UUID NOT NULL,
  "durationDays" INTEGER NOT NULL,
  "maxActivations" INTEGER,
  "startsAt" TIMESTAMPTZ(6),
  "endsAt" TIMESTAMPTZ(6),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "comment" VARCHAR(512),
  "archivedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "TrialCampaign_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrialCampaign_durationDays_check" CHECK ("durationDays" IN (1, 3, 5)),
  CONSTRAINT "TrialCampaign_maxActivations_check" CHECK ("maxActivations" IS NULL OR "maxActivations" > 0),
  CONSTRAINT "TrialCampaign_window_check" CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "startsAt" < "endsAt"),
  CONSTRAINT "TrialCampaign_archived_inactive_check" CHECK ("archivedAt" IS NULL OR NOT "isActive")
);

CREATE TABLE "TrialActivation" (
  "id" UUID NOT NULL,
  "trialCampaignId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "subscriptionId" UUID NOT NULL,
  "planId" UUID NOT NULL,
  "durationDays" INTEGER NOT NULL,
  "activatedAt" TIMESTAMPTZ(6) NOT NULL,
  "startsAt" TIMESTAMPTZ(6) NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "TrialActivation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrialActivation_durationDays_check" CHECK ("durationDays" IN (1, 3, 5)),
  CONSTRAINT "TrialActivation_time_snapshot_check" CHECK (
    "activatedAt" = "startsAt"
    AND "expiresAt" = "startsAt" + ("durationDays" * INTERVAL '1 day')
  )
);

CREATE UNIQUE INDEX "TrialCampaign_id_planId_key" ON "TrialCampaign"("id", "planId");
CREATE INDEX "TrialCampaign_planId_isActive_idx" ON "TrialCampaign"("planId", "isActive");
CREATE INDEX "TrialCampaign_isActive_startsAt_endsAt_idx" ON "TrialCampaign"("isActive", "startsAt", "endsAt");
CREATE UNIQUE INDEX "Subscription_id_userId_planId_key" ON "Subscription"("id", "userId", "planId");
CREATE UNIQUE INDEX "TrialActivation_userId_key" ON "TrialActivation"("userId");
CREATE UNIQUE INDEX "TrialActivation_subscriptionId_key" ON "TrialActivation"("subscriptionId");
CREATE UNIQUE INDEX "TrialActivation_subscriptionId_userId_planId_key" ON "TrialActivation"("subscriptionId", "userId", "planId");
CREATE INDEX "TrialActivation_trialCampaignId_activatedAt_idx" ON "TrialActivation"("trialCampaignId", "activatedAt");
CREATE INDEX "TrialActivation_planId_activatedAt_idx" ON "TrialActivation"("planId", "activatedAt");

ALTER TABLE "TrialCampaign"
  ADD CONSTRAINT "TrialCampaign_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TrialActivation"
  ADD CONSTRAINT "TrialActivation_trialCampaignId_planId_fkey"
  FOREIGN KEY ("trialCampaignId", "planId") REFERENCES "TrialCampaign"("id", "planId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TrialActivation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TrialActivation_subscriptionId_userId_planId_fkey"
  FOREIGN KEY ("subscriptionId", "userId", "planId") REFERENCES "Subscription"("id", "userId", "planId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "protect_trial_activation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'TrialActivation rows are append-only';
END
$$;

CREATE TRIGGER "TrialActivation_append_only"
BEFORE UPDATE OR DELETE ON "TrialActivation"
FOR EACH ROW
EXECUTE FUNCTION "protect_trial_activation"();

CREATE FUNCTION "protect_used_trial_campaign"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "TrialActivation"
    WHERE "trialCampaignId" = OLD."id"
  ) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Used TrialCampaign rows cannot be deleted';
    END IF;
    IF NEW."planId" <> OLD."planId" OR NEW."durationDays" <> OLD."durationDays" THEN
      RAISE EXCEPTION 'Used TrialCampaign entitlement fields are immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "TrialCampaign_protect_used"
BEFORE UPDATE OR DELETE ON "TrialCampaign"
FOR EACH ROW
EXECUTE FUNCTION "protect_used_trial_campaign"();

COMMIT;
