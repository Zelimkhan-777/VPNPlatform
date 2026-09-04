BEGIN;

LOCK TABLE "BotServiceCredential" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "BotServiceCredential"
    GROUP BY "principalId", "keyVersion"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'BotServiceCredential contains duplicate principal key versions';
  END IF;
END
$$;

CREATE UNIQUE INDEX "BotServiceCredential_principalId_keyVersion_key"
ON "BotServiceCredential"("principalId", "keyVersion");

COMMIT;
