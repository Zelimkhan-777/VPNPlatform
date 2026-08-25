import { Telegraf } from 'telegraf';
import { createSafeLogger } from '@vpn-platform/safe-logger';

const logger = createSafeLogger(process.env.LOG_LEVEL ?? 'info');

export function createBot(token: string): Telegraf {
  return new Telegraf(token);
}

logger.info(
  { component: 'bot', active: false },
  'Telegram bot scaffold is inactive; no token, polling, or webhook is configured',
);
