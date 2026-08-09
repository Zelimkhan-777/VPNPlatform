import pino from 'pino';
import { Telegraf } from 'telegraf';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export function createBot(token: string): Telegraf {
  return new Telegraf(token);
}

logger.info(
  { component: 'bot', active: false },
  'Telegram bot scaffold is inactive; no token, polling, or webhook is configured',
);
