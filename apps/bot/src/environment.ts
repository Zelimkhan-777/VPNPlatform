import { isAbsolute } from 'node:path';

export interface BotEnvironment {
  BOT_API_BASE_URL?: string;
  BOT_CREDENTIAL_FILE?: string;
  BOT_CREDENTIAL_GID?: number;
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
  const result: BotEnvironment = {
    BOT_SIGNING_ENABLED: enabled,
    LOG_LEVEL: environment.LOG_LEVEL ?? 'info',
  };
  if (!enabled) return result;

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
  return {
    ...result,
    BOT_API_BASE_URL: apiUrl.origin,
    BOT_CREDENTIAL_FILE: credentialFile,
    BOT_CREDENTIAL_GID: credentialGroupId,
  };
}
