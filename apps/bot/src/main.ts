import { Telegraf } from 'telegraf';
import { createSafeLogger } from '@vpn-platform/safe-logger';

import { createBotRequestSignerFromFile } from './bot-api-client';
import { parseBotEnvironment } from './environment';

export function createBot(token: string): Telegraf {
  return new Telegraf(token);
}

export function bootstrapBot(environment = process.env): void {
  const parsed = parseBotEnvironment(environment);
  const logger = createSafeLogger(parsed.LOG_LEVEL);
  if (!parsed.BOT_SIGNING_ENABLED) {
    logger.info(
      { component: 'bot', active: false },
      'Telegram bot scaffold is inactive; no token, polling, or webhook is configured',
    );
    return;
  }

  if (!parsed.BOT_CREDENTIAL_FILE || !parsed.BOT_CREDENTIAL_GID) {
    throw new Error('Bot signing configuration is invalid');
  }
  const signer = createBotRequestSignerFromFile(
    parsed.BOT_CREDENTIAL_FILE,
    parsed.BOT_CREDENTIAL_GID,
  );
  signer.destroy();
  logger.info(
    { component: 'bot', active: false, signingConfigured: true },
    'Telegram bot scaffold validated its API signing credential but remains inactive',
  );
}

if (require.main === module) {
  try {
    bootstrapBot();
  } catch {
    process.stderr.write('BOT_STARTUP_ERROR code=invalid-signing-wiring\n');
    process.exitCode = 1;
  }
}
