import {
  createBotSigningKek,
  readValidatedBotSigningKek,
} from './bot-signing-kek.mjs';

const targetPath = '/etc/meteora/platform-secrets/bot-signing-kek';
const apiSecretGroupId = 29001;

try {
  await createBotSigningKek(targetPath, apiSecretGroupId);
  await readValidatedBotSigningKek(targetPath, apiSecretGroupId);
  process.stdout.write(`BOT_SIGNING_KEK_CREATED path=${targetPath}\n`);
} catch (error) {
  process.stderr.write(
    `BOT_SIGNING_KEK_ERROR code=${error instanceof Error ? error.message : 'unknown'}\n`,
  );
  process.exitCode = 1;
}
