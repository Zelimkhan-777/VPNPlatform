import { describe, expect, it, vi } from 'vitest';

import { completeTelegramLogin, signInWithTelegram } from './auth-api';
import type { TelegramCompleteError, TelegramSignInError } from './auth-api';

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

describe('completeTelegramLogin', () => {
  it('sends only a same-origin complete request and ignores session JSON after success', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: {
            id: '11111111-1111-4111-8111-111111111111',
            role: 'CUSTOMER',
          },
          expiresAt: '2026-09-05T13:00:00.000Z',
        }),
        { status: 200 },
      ),
    );

    await expect(completeTelegramLogin(fetcher)).resolves.toBe('completed');
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/auth/telegram/complete', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
    });
    expect(JSON.stringify(fetcher.mock.calls[0])).not.toMatch(
      /cookie|vpn_platform|confirmationCode|initData/i,
    );
  });

  it('treats an unconfirmed pending cookie as still waiting', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(completeTelegramLogin(fetcher)).resolves.toBe('pending');
  });

  it('does not treat rate-limit or origin failures as a session', async () => {
    await expect(
      completeTelegramLogin(
        vi.fn().mockResolvedValueOnce(new Response(null, { status: 429 })),
      ),
    ).rejects.toMatchObject({
      kind: 'throttled',
    } satisfies Partial<TelegramCompleteError>);
    await expect(
      completeTelegramLogin(
        vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 })),
      ),
    ).rejects.toMatchObject({
      kind: 'rejected',
    } satisfies Partial<TelegramCompleteError>);
  });
});
