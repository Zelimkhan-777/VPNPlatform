import { randomBytes, randomUUID } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import { encryptBotSigningKey } from './bot-signing-key';

type TransactionClient = Parameters<
  Parameters<PrismaClient['$transaction']>[0]
>[0];

export interface BotCredentialMaterial {
  credentialId: string;
  keyVersion: number;
  principalId: string;
  signingKey: Buffer;
}

export interface BotCredentialChangeInput {
  principalName: string;
  reason: string;
}

export async function provisionBotCredential(
  prisma: PrismaClient,
  encodedKek: string,
  input: BotCredentialChangeInput,
): Promise<BotCredentialMaterial> {
  const validated = validateChangeInput(input);
  const signingKey = randomBytes(32);
  const credentialId = randomUUID();
  try {
    const created = await prisma.$transaction(async (transaction) => {
      await lockPrincipal(transaction, validated.principalName);
      const existingPrincipal =
        await transaction.botServicePrincipal.findUnique({
          where: { name: validated.principalName },
          select: { id: true },
        });
      if (existingPrincipal) {
        const [activeCredential, latestCredential] = await Promise.all([
          transaction.botServiceCredential.findFirst({
            where: {
              principalId: existingPrincipal.id,
              revokedAt: null,
            },
            select: { id: true },
          }),
          transaction.botServiceCredential.findFirst({
            where: { principalId: existingPrincipal.id },
            orderBy: { keyVersion: 'desc' },
            select: { keyVersion: true },
          }),
        ]);
        if (activeCredential) {
          throw new Error('Bot service principal already exists; use rotation');
        }
        const keyVersion = (latestCredential?.keyVersion ?? 0) + 1;
        const encrypted = encryptBotSigningKey(
          signingKey,
          encodedKek,
          {
            credentialId,
            principalId: existingPrincipal.id,
            keyVersion,
          },
          randomBytes(12),
        );
        await transaction.botServiceCredential.create({
          data: {
            id: credentialId,
            principalId: existingPrincipal.id,
            keyCiphertext: encrypted.keyCiphertext,
            nonce: encrypted.nonce,
            keyVersion,
          },
        });
        await writeCredentialAudit(transaction, {
          action: 'bot-service-credential.reprovisioned',
          credentialId,
          keyVersion,
          principalId: existingPrincipal.id,
          reason: validated.reason,
        });
        return { keyVersion, principalId: existingPrincipal.id };
      }
      const principalId = randomUUID();
      const encrypted = encryptBotSigningKey(
        signingKey,
        encodedKek,
        { credentialId, principalId, keyVersion: 1 },
        randomBytes(12),
      );
      await transaction.botServicePrincipal.create({
        data: {
          id: principalId,
          name: validated.principalName,
          credentials: {
            create: {
              id: credentialId,
              keyCiphertext: encrypted.keyCiphertext,
              nonce: encrypted.nonce,
              keyVersion: 1,
            },
          },
        },
      });
      await writeCredentialAudit(transaction, {
        action: 'bot-service-credential.provisioned',
        credentialId,
        keyVersion: 1,
        principalId,
        reason: validated.reason,
      });
      return { keyVersion: 1, principalId };
    });
    return { credentialId, signingKey, ...created };
  } catch (error) {
    signingKey.fill(0);
    throw error;
  }
}

export async function rotateBotCredential(
  prisma: PrismaClient,
  encodedKek: string,
  input: BotCredentialChangeInput,
): Promise<BotCredentialMaterial> {
  const validated = validateChangeInput(input);
  const signingKey = randomBytes(32);
  const credentialId = randomUUID();
  try {
    const created = await prisma.$transaction(async (transaction) => {
      await lockPrincipal(transaction, validated.principalName);
      const principal = await transaction.botServicePrincipal.findUnique({
        where: { name: validated.principalName },
        select: {
          id: true,
          credentials: {
            orderBy: { keyVersion: 'desc' },
            take: 1,
            select: { keyVersion: true },
          },
        },
      });
      if (!principal || principal.credentials.length === 0) {
        throw new Error('Bot service principal is not provisioned');
      }
      const activeCredentialCount =
        await transaction.botServiceCredential.count({
          where: { principalId: principal.id, revokedAt: null },
        });
      if (activeCredentialCount !== 1) {
        throw new Error(
          'Bot credential rotation requires exactly one active credential',
        );
      }
      const keyVersion = principal.credentials[0]!.keyVersion + 1;
      const encrypted = encryptBotSigningKey(
        signingKey,
        encodedKek,
        { credentialId, principalId: principal.id, keyVersion },
        randomBytes(12),
      );
      await transaction.botServiceCredential.create({
        data: {
          id: credentialId,
          principalId: principal.id,
          keyCiphertext: encrypted.keyCiphertext,
          nonce: encrypted.nonce,
          keyVersion,
        },
      });
      await writeCredentialAudit(transaction, {
        action: 'bot-service-credential.rotated',
        credentialId,
        keyVersion,
        principalId: principal.id,
        reason: validated.reason,
      });
      return { keyVersion, principalId: principal.id };
    });
    return { credentialId, signingKey, ...created };
  } catch (error) {
    signingKey.fill(0);
    throw error;
  }
}

export async function revokeBotCredential(
  prisma: PrismaClient,
  input: BotCredentialChangeInput & {
    credentialId?: string;
    keyVersion?: number;
    protectedCredentialId?: string;
  },
): Promise<{ changed: boolean; keyVersion: number }> {
  const validated = validateChangeInput(input);
  if ((input.credentialId === undefined) === (input.keyVersion === undefined)) {
    throw new Error('Exactly one credential selector is required');
  }
  if (input.credentialId !== undefined && !isUuid(input.credentialId)) {
    throw new Error('Credential ID is invalid');
  }
  if (
    input.keyVersion !== undefined &&
    (!Number.isSafeInteger(input.keyVersion) || input.keyVersion < 1)
  ) {
    throw new Error('Credential key version is invalid');
  }
  if (
    input.protectedCredentialId !== undefined &&
    !isUuid(input.protectedCredentialId)
  ) {
    throw new Error('Protected credential ID is invalid');
  }
  const credentialSelector: Prisma.BotServiceCredentialWhereInput =
    input.credentialId !== undefined
      ? { id: input.credentialId }
      : { keyVersion: input.keyVersion as number };
  return prisma.$transaction(async (transaction) => {
    await lockPrincipal(transaction, validated.principalName);
    const credential = await transaction.botServiceCredential.findFirst({
      where: {
        ...credentialSelector,
        principal: { name: validated.principalName },
      },
      select: {
        id: true,
        keyVersion: true,
        principalId: true,
        revokedAt: true,
      },
    });
    if (!credential) throw new Error('Bot service credential was not found');
    if (credential.id === input.protectedCredentialId) {
      throw new Error('Refusing to revoke the installed bot credential');
    }
    if (credential.revokedAt) {
      return { changed: false, keyVersion: credential.keyVersion };
    }
    await transaction.botServiceCredential.update({
      where: { id: credential.id },
      data: { revokedAt: new Date() },
    });
    await writeCredentialAudit(transaction, {
      action: 'bot-service-credential.revoked',
      credentialId: credential.id,
      keyVersion: credential.keyVersion,
      principalId: credential.principalId,
      reason: validated.reason,
    });
    return { changed: true, keyVersion: credential.keyVersion };
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function validateChangeInput(input: BotCredentialChangeInput) {
  const principalName = input.principalName.trim();
  const reason = input.reason.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(principalName)) {
    throw new Error('Principal name is invalid');
  }
  if (reason.length < 10 || reason.length > 500 || /[\r\n\0]/.test(reason)) {
    throw new Error('Reason must contain 10-500 single-line characters');
  }
  return { principalName, reason };
}

async function lockPrincipal(
  transaction: TransactionClient,
  principalName: string,
): Promise<void> {
  await transaction.$queryRaw`
    WITH acquired AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${'bot-service-principal-v1:' + principalName}, 0)
      )
    )
    SELECT 1::integer AS "locked"
    FROM acquired
  `;
}

async function writeCredentialAudit(
  transaction: TransactionClient,
  input: {
    action: string;
    credentialId: string;
    keyVersion: number;
    principalId: string;
    reason: string;
  },
): Promise<void> {
  const metadata: Prisma.InputJsonObject = {
    keyVersion: input.keyVersion,
    principalId: input.principalId,
    reason: input.reason,
  };
  await transaction.auditEvent.create({
    data: {
      action: input.action,
      entityType: 'BotServiceCredential',
      entityId: input.credentialId,
      metadata,
    },
  });
}
