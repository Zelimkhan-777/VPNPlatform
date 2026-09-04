import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  createBotRequestCanonicalString,
  type BotSignedRequestHeaders,
} from '@vpn-platform/contracts';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { decryptBotSigningKey } from './bot-signing-key';

export interface BotAuthenticationInput extends BotSignedRequestHeaders {
  method: string;
  path: string;
  rawBody: Buffer;
  telegramUserId: string;
}

export interface AuthenticatedBotRequest {
  credentialId: string;
  idempotencyKey: string;
  method: string;
  path: string;
  principalId: string;
  requestHash: string;
  telegramUserId: string;
}

@Injectable()
export class BotRequestAuthenticationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  async authenticate(
    input: BotAuthenticationInput,
  ): Promise<AuthenticatedBotRequest | null> {
    const encodedKek = this.environment.BOT_SIGNING_KEK;
    if (!encodedKek) return null;

    const credential = await this.prisma.botServiceCredential.findFirst({
      where: { id: input.credentialId, revokedAt: null },
      select: {
        id: true,
        principalId: true,
        keyCiphertext: true,
        nonce: true,
        keyVersion: true,
      },
    });
    if (!credential) return null;

    let signingKey: Buffer | undefined;
    try {
      signingKey = decryptBotSigningKey(
        {
          keyCiphertext: credential.keyCiphertext,
          nonce: credential.nonce,
        },
        encodedKek,
        {
          credentialId: credential.id,
          principalId: credential.principalId,
          keyVersion: credential.keyVersion,
        },
      );
      const rawBodySha256 = createHash('sha256')
        .update(input.rawBody)
        .digest('hex');
      const canonical = createBotRequestCanonicalString({
        credentialId: input.credentialId,
        method: input.method,
        path: input.path,
        timestamp: input.timestamp,
        nonce: input.nonce,
        telegramUserId: input.telegramUserId,
        idempotencyKey: input.idempotencyKey,
        rawBodySha256,
      });
      const expectedSignature = createHmac('sha256', signingKey)
        .update(canonical)
        .digest();
      const providedSignature = Buffer.from(input.signature, 'hex');
      if (
        providedSignature.length !== expectedSignature.length ||
        !timingSafeEqual(providedSignature, expectedSignature)
      ) {
        return null;
      }
    } catch {
      return null;
    } finally {
      signingKey?.fill(0);
    }

    const databaseClock = await this.prisma.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS "now"
    `;
    const now = databaseClock[0]?.now;
    const timestampSeconds = Number(input.timestamp);
    if (
      !now ||
      !Number.isSafeInteger(timestampSeconds) ||
      Math.abs(now.getTime() / 1_000 - timestampSeconds) > 30
    ) {
      return null;
    }

    let reserved: boolean;
    try {
      reserved = await this.redis.reserveOnce(
        `bot-nonce:${credential.principalId}:${input.nonce}`,
        120_000,
      );
    } catch {
      throw new ServiceUnavailableException(
        'Bot authentication is unavailable',
      );
    }
    if (!reserved) return null;

    return {
      credentialId: credential.id,
      idempotencyKey: input.idempotencyKey,
      method: input.method,
      path: input.path,
      principalId: credential.principalId,
      requestHash: createBotRequestHash(input),
      telegramUserId: input.telegramUserId,
    };
  }
}

export function createBotRequestHash(
  input: Pick<
    BotAuthenticationInput,
    'method' | 'path' | 'telegramUserId' | 'rawBody'
  >,
): string {
  return createHash('sha256')
    .update(input.method)
    .update('\n')
    .update(input.path)
    .update('\n')
    .update(input.telegramUserId)
    .update('\n')
    .update(input.rawBody)
    .digest('hex');
}
