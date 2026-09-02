import {
  createPlatformEnvironment,
  readValidatedPlatformEnvironment,
} from './platform-environment.mjs';

const configPath = '/etc/meteora/platform-config.env';
const telegramTokenPath = '/etc/meteora/platform-secrets/telegram-bot-token';
const targetPath = '/etc/meteora/platform.env';

try {
  await createPlatformEnvironment({
    configPath,
    telegramTokenPath,
    targetPath,
  });
  await readValidatedPlatformEnvironment(targetPath);
  process.stdout.write(`PLATFORM_ENV_CREATED path=${targetPath}\n`);
} catch (error) {
  process.stderr.write(
    `PLATFORM_ENV_ERROR code=${error instanceof Error ? error.message : 'unknown'}\n`,
  );
  process.exitCode = 1;
}
