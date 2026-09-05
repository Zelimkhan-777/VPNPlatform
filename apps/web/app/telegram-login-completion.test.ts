import { describe, expect, it, vi } from 'vitest';

import { TelegramCompleteError } from './auth-api';
import {
  TELEGRAM_COMPLETE_BACKOFF_MS,
  TELEGRAM_COMPLETE_POLL_INTERVAL_MS,
  waitForTelegramLoginCompletion,
} from './telegram-login-completion';

describe('waitForTelegramLoginCompletion', () => {
  it('polls complete until the original pending cookie is replaced', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce('pending')
      .mockResolvedValueOnce('completed');
    const delays: number[] = [];

    await expect(
      waitForTelegramLoginCompletion({
        expiresAt: '2026-09-05T12:02:00.000Z',
        complete,
        now: () => Date.parse('2026-09-05T12:00:00.000Z'),
        delay: async (ms) => {
          delays.push(ms);
        },
      }),
    ).resolves.toBe('completed');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([TELEGRAM_COMPLETE_POLL_INTERVAL_MS]);
  });

  it('backs off on rate-limit and dependency failures without finishing login', async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(
        new TelegramCompleteError('throttled', 'throttled'),
      )
      .mockRejectedValueOnce(
        new TelegramCompleteError('unavailable', 'unavailable'),
      )
      .mockResolvedValueOnce('completed');
    const delays: number[] = [];

    await expect(
      waitForTelegramLoginCompletion({
        expiresAt: '2026-09-05T12:02:00.000Z',
        complete,
        now: () => Date.parse('2026-09-05T12:00:00.000Z'),
        delay: async (ms) => {
          delays.push(ms);
        },
      }),
    ).resolves.toBe('completed');
    expect(delays).toEqual([
      TELEGRAM_COMPLETE_BACKOFF_MS,
      TELEGRAM_COMPLETE_BACKOFF_MS,
    ]);
  });

  it('stops immediately on an origin rejection without another complete call', async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new TelegramCompleteError('rejected', 'rejected'));
    const delay = vi.fn();

    await expect(
      waitForTelegramLoginCompletion({
        expiresAt: '2026-09-05T12:02:00.000Z',
        complete,
        now: () => Date.parse('2026-09-05T12:00:00.000Z'),
        delay,
      }),
    ).resolves.toBe('rejected');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('stops after expiry without calling complete again', async () => {
    const complete = vi.fn();

    await expect(
      waitForTelegramLoginCompletion({
        expiresAt: '2026-09-05T12:00:00.000Z',
        complete,
        now: () => Date.parse('2026-09-05T12:00:00.000Z'),
        delay: async () => undefined,
      }),
    ).resolves.toBe('expired');
    expect(complete).not.toHaveBeenCalled();
  });

  it('aborts an in-flight wait without treating it as expiry', async () => {
    const controller = new AbortController();
    const complete = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });

    await expect(
      waitForTelegramLoginCompletion({
        expiresAt: '2026-09-05T12:02:00.000Z',
        complete,
        now: () => Date.parse('2026-09-05T12:00:00.000Z'),
        delay: async () => undefined,
        signal: controller.signal,
      }),
    ).resolves.toBe('aborted');
  });
});
