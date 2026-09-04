import { createInterface } from 'node:readline/promises';

import { PrismaClient } from '@prisma/client';

import {
  provisionBotCredential,
  revokeBotCredential,
  rotateBotCredential,
  type BotCredentialMaterial,
} from '../auth/bot-credential-lifecycle';
import { readPrivateSecretFile } from '../config/private-secret-file';
import {
  assertBotCredentialTarget,
  installBotCredential,
  readInstalledBotCredential,
} from './bot-credential-file';

type Action = 'provision' | 'rotate' | 'revoke';

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive TTY is required');
  }
  const action = parseAction(process.argv.slice(2));
  const kekPath = requiredEnvironmentPath('BOT_SIGNING_KEK_FILE');
  const kekGroupId = requiredGroupId('BOT_SIGNING_KEK_GID');
  const credentialPath = requiredEnvironmentPath('BOT_CREDENTIAL_OUTPUT_FILE');
  const credentialGroupId = requiredGroupId('BOT_CREDENTIAL_GROUP_ID');
  const encodedKek = readPrivateSecretFile(
    kekPath,
    /^[A-Za-z0-9_-]{43}\n?$/,
    'Bot signing KEK',
    kekGroupId,
  );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const prisma = new PrismaClient();
  try {
    const principalName = await prompt.question('Bot principal name: ');
    const reason = await prompt.question('Reason (10-500 characters): ');
    if (action === 'revoke') {
      const keyVersionInput = await prompt.question('Key version to revoke: ');
      const keyVersion = Number(keyVersionInput);
      const active = await readInstalledBotCredential(
        credentialPath,
        credentialGroupId,
      );
      await requireConfirmation(prompt, 'REVOKE BOT CREDENTIAL');
      const result = await revokeBotCredential(prisma, {
        principalName,
        reason,
        keyVersion,
        protectedCredentialId: active.credentialId,
      });
      process.stdout.write(
        `BOT_CREDENTIAL_REVOKE_COMPLETE changed=${String(result.changed)} keyVersion=${result.keyVersion}\n`,
      );
      return;
    }

    await requireConfirmation(
      prompt,
      action === 'provision'
        ? 'PROVISION BOT CREDENTIAL'
        : 'ROTATE BOT CREDENTIAL',
    );
    await assertBotCredentialTarget(
      credentialPath,
      action === 'rotate',
      credentialGroupId,
    );
    if (action === 'rotate') {
      const active = await readInstalledBotCredential(
        credentialPath,
        credentialGroupId,
      );
      const activeForPrincipal = await prisma.botServiceCredential.findFirst({
        where: {
          id: active.credentialId,
          revokedAt: null,
          principal: { name: principalName.trim() },
        },
        select: { id: true },
      });
      if (!activeForPrincipal) {
        throw new Error(
          'Installed credential does not belong to the requested principal',
        );
      }
    }
    const material =
      action === 'provision'
        ? await provisionBotCredential(prisma, encodedKek, {
            principalName,
            reason,
          })
        : await rotateBotCredential(prisma, encodedKek, {
            principalName,
            reason,
          });
    await persistMaterial(
      prisma,
      credentialPath,
      principalName,
      material,
      action === 'rotate',
      credentialGroupId,
    );
    process.stdout.write(
      `BOT_CREDENTIAL_${action.toUpperCase()}_COMPLETE keyVersion=${material.keyVersion}\n`,
    );
  } finally {
    prompt.close();
    await prisma.$disconnect();
  }
}

async function persistMaterial(
  prisma: PrismaClient,
  credentialPath: string,
  principalName: string,
  material: BotCredentialMaterial,
  replace: boolean,
  credentialGroupId: number,
): Promise<void> {
  try {
    await installBotCredential(
      credentialPath,
      {
        formatVersion: 1,
        credentialId: material.credentialId,
        signingKey: material.signingKey.toString('base64url'),
      },
      replace,
      credentialGroupId,
    );
  } catch (error) {
    try {
      await revokeBotCredential(prisma, {
        principalName,
        credentialId: material.credentialId,
        reason:
          'Automatic compensation after credential file installation failed',
      });
    } catch (compensationError) {
      throw new Error(
        'Credential file installation and compensation both failed',
        { cause: compensationError },
      );
    }
    throw error;
  } finally {
    material.signingKey.fill(0);
  }
}

function parseAction(arguments_: string[]): Action {
  if (
    arguments_.length !== 1 ||
    !['provision', 'rotate', 'revoke'].includes(arguments_[0] ?? '')
  ) {
    throw new Error('Expected exactly one action: provision, rotate or revoke');
  }
  return arguments_[0] as Action;
}

function requiredEnvironmentPath(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function requiredGroupId(key: string): number {
  const value = Number(process.env[key]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${key} must be a valid group ID`);
  }
  return value;
}

async function requireConfirmation(
  prompt: ReturnType<typeof createInterface>,
  expected: string,
): Promise<void> {
  const confirmation = await prompt.question(`Type ${expected} to continue: `);
  if (confirmation !== expected) throw new Error('Confirmation did not match');
}

void main().catch((error: unknown) => {
  const allowedMessages = new Set([
    'Interactive TTY is required',
    'Confirmation did not match',
    'Bot service principal already exists; use rotation',
    'Bot service principal is not provisioned',
    'Bot service credential was not found',
    'Refusing to revoke the installed bot credential',
    'Installed credential does not belong to the requested principal',
  ]);
  const message =
    error instanceof Error && allowedMessages.has(error.message)
      ? error.message
      : 'Bot credential operation failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
