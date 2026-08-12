import { describe, expect, it, vi } from 'vitest';

import { getTelegramWebAppInitData } from './telegram-web-app';

describe('getTelegramWebAppInitData', () => {
  it('uses Telegram initData only in memory and notifies the host that the app is ready', () => {
    const ready = vi.fn();
    const initData = getTelegramWebAppInitData({
      Telegram: { WebApp: { initData: 'signed-data', ready } },
    });

    expect(initData).toBe('signed-data');
    expect(ready).toHaveBeenCalledOnce();
  });

  it('does not invent a Telegram identity outside the Telegram host', () => {
    expect(getTelegramWebAppInitData(undefined)).toBeNull();
    expect(getTelegramWebAppInitData({})).toBeNull();
    expect(
      getTelegramWebAppInitData({
        Telegram: { WebApp: { initData: '', ready: vi.fn() } },
      }),
    ).toBeNull();
  });
});
