import { readValidatedPlatformEnvironment } from './platform-environment.mjs';

const targetPath = '/etc/meteora/platform.env';

try {
  await readValidatedPlatformEnvironment(targetPath);
  process.stdout.write(`PLATFORM_ENV_VALID path=${targetPath}\n`);
} catch (error) {
  process.stderr.write(
    `PLATFORM_ENV_ERROR code=${error instanceof Error ? error.message : 'unknown'}\n`,
  );
  process.exitCode = 1;
}
