interface TelegramWebApp {
  initData: string;
  ready(): void;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

/**
 * Reads the signed payload supplied by the Telegram host without persisting it.
 * The API remains responsible for its cryptographic verification.
 */
export function getTelegramWebAppInitData(
  browserWindow: Pick<Window, 'Telegram'> | undefined,
): string | null {
  const webApp = browserWindow?.Telegram?.WebApp;
  if (!webApp?.initData) {
    return null;
  }

  webApp.ready();
  return webApp.initData;
}
