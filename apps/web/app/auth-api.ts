import {
  pendingTelegramLoginSchema,
  type PendingTelegramLogin,
} from '@vpn-platform/contracts';

export class TelegramSignInError extends Error {
  constructor(
    message: string,
    readonly kind: 'rejected' | 'unavailable' | 'invalid-response',
  ) {
    super(message);
  }
}

export async function signInWithTelegram(
  initData: string,
  fetcher: typeof fetch = fetch,
): Promise<PendingTelegramLogin> {
  let response: Response;
  try {
    response = await fetcher('/api/auth/telegram', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData }),
    });
  } catch {
    throw new TelegramSignInError(
      'Telegram sign-in is unavailable',
      'unavailable',
    );
  }

  if (response.status === 401 || response.status === 400) {
    throw new TelegramSignInError('Telegram sign-in was rejected', 'rejected');
  }
  if (!response.ok) {
    throw new TelegramSignInError(
      'Telegram sign-in is unavailable',
      'unavailable',
    );
  }

  const result = pendingTelegramLoginSchema.safeParse(await response.json());
  if (!result.success) {
    throw new TelegramSignInError(
      'Telegram sign-in returned an invalid response',
      'invalid-response',
    );
  }

  return result.data;
}
