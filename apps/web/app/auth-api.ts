import {
  authenticatedSessionSchema,
  type AuthenticatedSession,
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
): Promise<AuthenticatedSession> {
  let response: Response;
  try {
    const challenge = await fetcher('/api/auth/challenge', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!challenge.ok) {
      throw new Error('challenge unavailable');
    }
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

  const result = authenticatedSessionSchema.safeParse(await response.json());
  if (!result.success) {
    throw new TelegramSignInError(
      'Telegram sign-in returned an invalid response',
      'invalid-response',
    );
  }

  return result.data;
}
