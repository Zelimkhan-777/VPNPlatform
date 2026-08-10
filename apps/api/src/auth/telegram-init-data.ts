import { createHmac, timingSafeEqual } from 'node:crypto';

interface TelegramInitDataUser {
  id: string;
}

export class TelegramInitDataValidationError extends Error {}

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number,
  now = new Date(),
): TelegramInitDataUser {
  const parameters = new URLSearchParams(initData);
  const hash = uniqueParameter(parameters, 'hash');
  const authDate = uniqueParameter(parameters, 'auth_date');
  const user = uniqueParameter(parameters, 'user');

  if (!hash || !authDate || !user || !/^[a-f0-9]{64}$/i.test(hash)) {
    throw new TelegramInitDataValidationError(
      'Telegram init data is malformed',
    );
  }

  const dataCheckString = [...parameters.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const expectedHash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest();
  const receivedHash = Buffer.from(hash, 'hex');

  if (
    receivedHash.length !== expectedHash.length ||
    !timingSafeEqual(receivedHash, expectedHash)
  ) {
    throw new TelegramInitDataValidationError(
      'Telegram init data signature is invalid',
    );
  }

  const authTimestamp = Number(authDate);
  const nowTimestamp = Math.floor(now.getTime() / 1_000);
  if (
    !Number.isSafeInteger(authTimestamp) ||
    authTimestamp > nowTimestamp ||
    nowTimestamp - authTimestamp > maxAgeSeconds
  ) {
    throw new TelegramInitDataValidationError('Telegram init data has expired');
  }

  return parseTelegramUser(user);
}

function uniqueParameter(
  parameters: URLSearchParams,
  key: string,
): string | null {
  const values = parameters.getAll(key);

  return values.length === 1 ? (values[0] ?? null) : null;
}

function parseTelegramUser(serializedUser: string): TelegramInitDataUser {
  try {
    const parsed: unknown = JSON.parse(serializedUser);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('id' in parsed) ||
      (typeof parsed.id !== 'number' && typeof parsed.id !== 'string')
    ) {
      throw new TelegramInitDataValidationError(
        'Telegram init data user is invalid',
      );
    }

    const id = String(parsed.id);
    if (!/^\d{1,32}$/.test(id)) {
      throw new TelegramInitDataValidationError(
        'Telegram init data user is invalid',
      );
    }

    return { id };
  } catch (error) {
    if (error instanceof TelegramInitDataValidationError) {
      throw error;
    }

    throw new TelegramInitDataValidationError(
      'Telegram init data user is invalid',
    );
  }
}
