import { createSafeLogger } from '@vpn-platform/safe-logger';
import { Markup, Telegraf } from 'telegraf';

import {
  createBotRequestSignerFromFile,
  readTelegramBotTokenFile,
} from './bot-api-client';
import { parseBotEnvironment } from './environment';
import {
  handleConfirmationMessage,
  TelegramConfirmationClient,
} from './telegram-confirmation';
import {
  handleLoginLaunchMessage,
  TelegramLoginLaunchClient,
} from './telegram-login-launch';

export function createBot(token: string): Telegraf {
  return new Telegraf(token);
}

export async function bootstrapBot(environment = process.env): Promise<void> {
  const parsed = parseBotEnvironment(environment);
  const logger = createSafeLogger(parsed.LOG_LEVEL);
  if (!parsed.BOT_SIGNING_ENABLED) {
    logger.info(
      { component: 'bot', active: false },
      'Telegram bot is inactive',
    );
    return;
  }

  if (
    !parsed.BOT_CREDENTIAL_FILE ||
    !parsed.BOT_CREDENTIAL_GID ||
    !parsed.BOT_API_BASE_URL
  ) {
    throw new Error('Bot signing configuration is invalid');
  }
  const signer = createBotRequestSignerFromFile(
    parsed.BOT_CREDENTIAL_FILE,
    parsed.BOT_CREDENTIAL_GID,
  );
  if (parsed.BOT_TELEGRAM_MODE === 'inactive') {
    signer.destroy();
    logger.info(
      { component: 'bot', active: false, signingConfigured: true },
      'Telegram bot signing configuration is valid; bot is inactive',
    );
    return;
  }
  if (!parsed.TELEGRAM_BOT_TOKEN_FILE || !parsed.TELEGRAM_MINI_APP_BASE_URL) {
    signer.destroy();
    throw new Error('Telegram polling configuration is invalid');
  }
  const miniAppBaseUrl = parsed.TELEGRAM_MINI_APP_BASE_URL;

  const token = readTelegramBotTokenFile(
    parsed.TELEGRAM_BOT_TOKEN_FILE,
    parsed.BOT_CREDENTIAL_GID,
  );
  const bot = createBot(token);
  const confirmations = new TelegramConfirmationClient(
    parsed.BOT_API_BASE_URL,
    signer,
  );
  const launches = new TelegramLoginLaunchClient(
    parsed.BOT_API_BASE_URL,
    signer,
  );
  bot.on('text', async (context) => {
    const input = {
      text: context.message.text,
      telegramUserId: String(context.from.id),
      updateId: context.update.update_id,
    };
    const launchReply = await handleLoginLaunchMessage(
      input,
      launches,
      miniAppBaseUrl,
    );
    if (launchReply) {
      if (launchReply.miniAppUrl) {
        await context.reply(
          launchReply.text,
          Markup.inlineKeyboard([
            Markup.button.url('Открыть кабинет', launchReply.miniAppUrl),
          ]),
        );
      } else {
        await context.reply(launchReply.text);
      }
      return;
    }
    const reply = await handleConfirmationMessage(input, confirmations);
    if (!reply) return;
    await context.reply(reply);
  });
  bot.catch(() => {
    logger.error(
      { component: 'bot', event: 'handler-error' },
      'Telegram update handling failed',
    );
  });

  let stopped = false;
  const stop = (signal: 'SIGINT' | 'SIGTERM') => {
    if (stopped) return;
    stopped = true;
    try {
      bot.stop(signal);
    } finally {
      signer.destroy();
    }
  };
  const onSigint = () => stop('SIGINT');
  const onSigterm = () => stop('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    await bot.launch({}, () =>
      logger.info(
        { component: 'bot', active: true },
        'Telegram bot polling started',
      ),
    );
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    signer.destroy();
  }
}

if (require.main === module) {
  try {
    void bootstrapBot().catch(() => {
      process.stderr.write('BOT_STARTUP_ERROR code=invalid-runtime-wiring\n');
      process.exitCode = 1;
    });
  } catch {
    process.stderr.write('BOT_STARTUP_ERROR code=invalid-runtime-wiring\n');
    process.exitCode = 1;
  }
}
