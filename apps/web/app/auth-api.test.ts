import { describe, expect, it, vi } from 'vitest';

import { signInWithTelegram } from './auth-api';
import type { TelegramSignInError } from './auth-api';

describe('signInWithTelegram', () => {
  it('sends initData only to the same-origin API and accepts a strict session response', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          user: {
            id: '82ef72a5-0c97-4fbd-9600-c64db2d01ca9',
            role: 'CUSTOMER',
          },
          expiresAt: '2026-08-12T12:00:00.000Z',
        }),
        { status: 200 },
      ),
    );

    await expect(
      signInWithTelegram('signed-init-data', fetcher),
    ).resolves.toEqual({
      user: { id: '82ef72a5-0c97-4fbd-9600-c64db2d01ca9', role: 'CUSTOMER' },
      expiresAt: '2026-08-12T12:00:00.000Z',
    });
    expect(fetcher).toHaveBeenCalledWith('/api/auth/telegram', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: 'signed-init-data' }),
    });
  });

  it('does not treat rejected Telegram data as an authenticated session', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));

    await expect(
      signInWithTelegram('forged-data', fetcher),
    ).rejects.toMatchObject({
      kind: 'rejected',
    } satisfies Partial<TelegramSignInError>);
  });
});
