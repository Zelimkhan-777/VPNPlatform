BEGIN;

LOCK TABLE "PendingLogin" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PendingLogin"
    GROUP BY "telegramUserId", "confirmationCodeHash"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'PendingLogin contains duplicate Telegram confirmation codes';
  END IF;
END
$$;

CREATE UNIQUE INDEX "PendingLogin_confirmation_scope_key"
ON "PendingLogin"("telegramUserId", "confirmationCodeHash");

COMMIT;
