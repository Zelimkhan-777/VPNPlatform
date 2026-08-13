import { createHmac, timingSafeEqual } from 'node:crypto';

interface TelegramInitDataUser {
  id: string;
}

interface VerifiedTelegramInitData extends TelegramInitDataUser {
  replayKey: string;
  startParam: string;
}

export class TelegramInitDataValidationError extends Error {}

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number,
  now = new Date(),
): VerifiedTelegramInitData {
  const parameters = new URLSearchParams(initData);
  const hash = uniqueParameter(parameters, 'hash');
  const authDate = uniqueParameter(parameters, 'auth_date');
  const user = uniqueParameter(parameters, 'user');
  const startParam = uniqueParameter(parameters, 'start_param');

  if (
    !hash ||
    !authDate ||
    !user ||
    !startParam ||
    !/^[a-f0-9]{64}$/i.test(hash) ||
    !/^[A-Za-z0-9_-]{43}$/.test(startParam)
  ) {
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

  // `start_param` authenticates which trusted launch context is being used,
  // but must not turn one Telegram ceremony into multiple replay identities.
  const replayKey = [...parameters.entries()]
    .filter(([key]) => key !== 'hash' && key !== 'start_param')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  return { ...parseTelegramUser(user), replayKey, startParam };
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
