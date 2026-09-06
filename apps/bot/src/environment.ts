import { isAbsolute } from 'node:path';

export interface BotEnvironment {
  BOT_API_BASE_URL?: string;
  BOT_CREDENTIAL_FILE?: string;
  BOT_CREDENTIAL_GID?: number;
  TELEGRAM_MINI_APP_BASE_URL?: string;
  BOT_TELEGRAM_MODE: 'inactive' | 'polling';
  TELEGRAM_BOT_TOKEN_FILE?: string;
  BOT_SIGNING_ENABLED: boolean;
  LOG_LEVEL: string;
}

export function parseBotEnvironment(
  environment: NodeJS.ProcessEnv,
): BotEnvironment {
  const enabledValue = environment.BOT_SIGNING_ENABLED ?? 'false';
  if (enabledValue !== 'true' && enabledValue !== 'false') {
    throw new Error('BOT_SIGNING_ENABLED must be true or false');
  }
  const enabled = enabledValue === 'true';
  const telegramMode = environment.BOT_TELEGRAM_MODE ?? 'inactive';
  if (telegramMode !== 'inactive' && telegramMode !== 'polling') {
    throw new Error('BOT_TELEGRAM_MODE must be inactive or polling');
  }
  const result: BotEnvironment = {
    BOT_SIGNING_ENABLED: enabled,
    BOT_TELEGRAM_MODE: telegramMode,
    LOG_LEVEL: environment.LOG_LEVEL ?? 'info',
  };
  if (!enabled) {
    if (telegramMode === 'polling') {
      throw new Error('BOT_SIGNING_ENABLED must be true in polling mode');
    }
    return result;
  }

  if (!environment.BOT_API_BASE_URL) {
    throw new Error('BOT_API_BASE_URL is required');
  }
  const apiUrl = new URL(environment.BOT_API_BASE_URL);
  if (
    apiUrl.protocol !== 'http:' ||
    apiUrl.hostname !== 'api' ||
    apiUrl.port !== '3001' ||
    apiUrl.pathname !== '/' ||
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.search ||
    apiUrl.hash
  ) {
    throw new Error('BOT_API_BASE_URL must be the internal API origin');
  }
  const credentialFile = environment.BOT_CREDENTIAL_FILE;
  if (!credentialFile || !isAbsolute(credentialFile)) {
    throw new Error('BOT_CREDENTIAL_FILE must be an absolute path');
  }
  const credentialGroupId = Number(environment.BOT_CREDENTIAL_GID);
  if (
    !Number.isSafeInteger(credentialGroupId) ||
    credentialGroupId < 1 ||
    credentialGroupId > 65_535
  ) {
    throw new Error('BOT_CREDENTIAL_GID must be a valid group ID');
  }
  const tokenFile = environment.TELEGRAM_BOT_TOKEN_FILE;
  if (telegramMode === 'polling' && (!tokenFile || !isAbsolute(tokenFile))) {
    throw new Error('TELEGRAM_BOT_TOKEN_FILE must be an absolute path');
  }
  const miniAppBaseUrl = environment.TELEGRAM_MINI_APP_BASE_URL;
  if (telegramMode === 'polling' && !miniAppBaseUrl) {
    throw new Error('TELEGRAM_MINI_APP_BASE_URL is required');
  }
  if (miniAppBaseUrl) {
    assertTelegramMiniAppBaseUrl(miniAppBaseUrl);
  }
  return {
    ...result,
    BOT_API_BASE_URL: apiUrl.origin,
    BOT_CREDENTIAL_FILE: credentialFile,
    BOT_CREDENTIAL_GID: credentialGroupId,
    ...(tokenFile ? { TELEGRAM_BOT_TOKEN_FILE: tokenFile } : {}),
    ...(miniAppBaseUrl ? { TELEGRAM_MINI_APP_BASE_URL: miniAppBaseUrl } : {}),
  };
}

function assertTelegramMiniAppBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      'TELEGRAM_MINI_APP_BASE_URL must be a direct Telegram Mini App link',
    );
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 't.me' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    segments.length !== 2 ||
    !/^[a-z][a-z0-9_]{1,28}bot$/i.test(segments[0] ?? '') ||
    !/^[a-z0-9_]{1,64}$/i.test(segments[1] ?? '')
  ) {
    throw new Error(
      'TELEGRAM_MINI_APP_BASE_URL must be a direct Telegram Mini App link',
    );
  }
}
