import { describe, expect, it, vi } from 'vitest';

import { signInWithTelegram } from './auth-api';
import type { TelegramSignInError } from './auth-api';

describe('signInWithTelegram', () => {
  it('sends initData only to the same-origin API and accepts a strict pending response', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          confirmationCode: '01AB2CD3',
          expiresAt: '2026-09-05T12:02:00.000Z',
        }),
        { status: 200 },
      ),
    );

    await expect(
      signInWithTelegram('signed-init-data', fetcher),
    ).resolves.toEqual({
      confirmationCode: '01AB2CD3',
      expiresAt: '2026-09-05T12:02:00.000Z',
    });
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/auth/telegram', {
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
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(
      signInWithTelegram('forged-data', fetcher),
    ).rejects.toMatchObject({
      kind: 'rejected',
    } satisfies Partial<TelegramSignInError>);
  });
});
