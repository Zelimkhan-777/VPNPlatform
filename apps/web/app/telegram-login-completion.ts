import { completeTelegramLogin, TelegramCompleteError } from './auth-api';

export const TELEGRAM_COMPLETE_POLL_INTERVAL_MS = 8_000;
export const TELEGRAM_COMPLETE_BACKOFF_MS = 15_000;

export type TelegramLoginCompletionOutcome =
  'completed' | 'expired' | 'rejected' | 'aborted';

export async function waitForTelegramLoginCompletion(input: {
  expiresAt: string;
  complete?: typeof completeTelegramLogin;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<TelegramLoginCompletionOutcome> {
  const complete = input.complete ?? completeTelegramLogin;
  const delay = input.delay ?? defaultDelay;
  const now = input.now ?? Date.now;

  while (!input.signal?.aborted) {
    if (Date.parse(input.expiresAt) <= now()) {
      return 'expired';
    }

    try {
      const outcome = await complete(fetch, input.signal);
      if (input.signal?.aborted) {
        return 'aborted';
      }
      if (outcome === 'completed') {
        return 'completed';
      }
      await delay(TELEGRAM_COMPLETE_POLL_INTERVAL_MS, input.signal);
    } catch (error) {
      if (input.signal?.aborted) {
        return 'aborted';
      }
      if (error instanceof TelegramCompleteError && error.kind === 'rejected') {
        return 'rejected';
      }
      await delay(
        error instanceof TelegramCompleteError &&
          (error.kind === 'throttled' || error.kind === 'unavailable')
          ? TELEGRAM_COMPLETE_BACKOFF_MS
          : TELEGRAM_COMPLETE_POLL_INTERVAL_MS,
        input.signal,
      );
    }
  }

  return 'aborted';
}

async function defaultDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
