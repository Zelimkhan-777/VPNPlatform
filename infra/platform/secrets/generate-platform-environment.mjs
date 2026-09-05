import {
  createPlatformEnvironment,
  readValidatedPlatformEnvironment,
} from './platform-environment.mjs';

const configPath = '/etc/meteora/platform-config.env';
const telegramTokenPath = '/etc/meteora/telegram-secrets/bot-token';
const targetPath = '/etc/meteora/platform.env';
const telegramTokenGroupId = 29002;

try {
  await createPlatformEnvironment({
    configPath,
    telegramTokenPath,
    targetPath,
    telegramTokenGroupId,
  });
  await readValidatedPlatformEnvironment(targetPath);
  process.stdout.write(`PLATFORM_ENV_CREATED path=${targetPath}\n`);
} catch (error) {
  process.stderr.write(
    `PLATFORM_ENV_ERROR code=${error instanceof Error ? error.message : 'unknown'}\n`,
  );
  process.exitCode = 1;
}
