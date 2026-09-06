// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadCabinetState } from './cabinet-queries';

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.Telegram;
});

describe('Telegram browser login bootstrap', () => {
  it('uses SDK initData to start exactly one pending login request', async () => {
    const ready = vi.fn();
    window.Telegram = {
      WebApp: { initData: 'signed-init-data', ready },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            confirmationCode: '01AB2CD3',
            expiresAt: '2026-09-06T12:02:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetcher);

    await expect(loadCabinetState()).resolves.toEqual({
      kind: 'confirmation-required',
      pending: {
        confirmationCode: '01AB2CD3',
        expiresAt: '2026-09-06T12:02:00.000Z',
      },
    });
    expect(ready).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      '/api/cabinet/overview',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      '/api/auth/telegram',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ initData: 'signed-init-data' }),
        credentials: 'same-origin',
      }),
    );
  });
});
