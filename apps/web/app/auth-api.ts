import {
  authenticatedSessionSchema,
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

export class TelegramCompleteError extends Error {
  constructor(
    message: string,
    readonly kind:
      'rejected' | 'throttled' | 'unavailable' | 'invalid-response',
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

export async function completeTelegramLogin(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<'completed' | 'pending'> {
  let response: Response;
  try {
    response = await fetcher('/api/auth/telegram/complete', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new TelegramCompleteError(
      'Telegram login completion is unavailable',
      'unavailable',
    );
  }

  if (response.status === 401) {
    return 'pending';
  }
  if (response.status === 403) {
    throw new TelegramCompleteError(
      'Telegram login completion was rejected',
      'rejected',
    );
  }
  if (response.status === 429) {
    throw new TelegramCompleteError(
      'Telegram login completion was throttled',
      'throttled',
    );
  }
  if (!response.ok) {
    throw new TelegramCompleteError(
      'Telegram login completion is unavailable',
      'unavailable',
    );
  }

  const result = authenticatedSessionSchema.safeParse(await response.json());
  if (!result.success) {
    throw new TelegramCompleteError(
      'Telegram login completion returned an invalid response',
      'invalid-response',
    );
  }

  return 'completed';
}
