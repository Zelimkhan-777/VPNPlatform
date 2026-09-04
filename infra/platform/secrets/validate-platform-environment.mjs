import { readValidatedPlatformEnvironment } from './platform-environment.mjs';
import {
  readValidatedBotSigningKek,
  validateInstalledBotCredential,
} from './bot-signing-kek.mjs';

const targetPath = '/etc/meteora/platform.env';
const botKekPath = '/etc/meteora/platform-secrets/bot-signing-kek';
const botCredentialPath = '/etc/meteora/bot-secrets/credential';
const apiSecretGroupId = 29001;
const botSecretGroupId = 29002;

try {
  await readValidatedPlatformEnvironment(targetPath);
  await readValidatedBotSigningKek(botKekPath, apiSecretGroupId);
  await validateInstalledBotCredential(botCredentialPath, botSecretGroupId);
  process.stdout.write(`PLATFORM_ENV_VALID path=${targetPath}\n`);
} catch (error) {
  process.stderr.write(
    `PLATFORM_ENV_ERROR code=${error instanceof Error ? error.message : 'unknown'}\n`,
  );
  process.exitCode = 1;
}
