import { createHash, createHmac } from 'node:crypto';

import { createBotRequestCanonicalString } from '@vpn-platform/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { ApiEnvironment } from '../config/environment';
import type { PrismaService } from '../database/prisma.service';
import type { RedisService } from '../redis/redis.service';
import {
  BotRequestAuthenticationService,
  createBotRequestHash,
} from './bot-request-authentication.service';
import { encryptBotSigningKey } from './bot-signing-key';

const credentialId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const telegramUserId = '123456789';
const signingKey = Buffer.alloc(32, 7);
const encodedKek = Buffer.alloc(32, 9).toString('base64url');
const rawBody = Buffer.from(JSON.stringify({ telegramUserId, code: 'ABC' }));
const timestamp = '1788436800';
const method = 'POST';
const path = '/internal/bot/auth/confirm';
const nonce = 'nonce-for-service';
const idempotencyKey = 'login-confirmation-1';

function encryptedCredential(kek = encodedKek) {
  const encrypted = encryptBotSigningKey(
    signingKey,
    kek,
    { credentialId, principalId, keyVersion: 1 },
    Buffer.alloc(12, 5),
  );
  return {
    id: credentialId,
    principalId,
    keyVersion: 1,
    ...encrypted,
  };
}

function signature(
  body = rawBody,
  requestIdempotencyKey = idempotencyKey,
): string {
  const rawBodySha256 = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', signingKey)
    .update(
      createBotRequestCanonicalString({
        credentialId,
        method,
        path,
        timestamp,
        nonce,
        telegramUserId,
        idempotencyKey: requestIdempotencyKey,
        rawBodySha256,
      }),
    )
    .digest('hex');
}

function harness(input?: {
  environmentKek?: string | undefined;
  credential?: ReturnType<typeof encryptedCredential> | null;
  databaseNow?: Date;
  reservation?: boolean;
  reservationError?: Error;
}) {
  const findFirst = vi
    .fn()
    .mockResolvedValue(
      input?.credential === undefined
        ? encryptedCredential()
        : input.credential,
    );
  const databaseClock = vi
    .fn()
    .mockResolvedValue([
      { now: input?.databaseNow ?? new Date(Number(timestamp) * 1_000) },
    ]);
  const prisma = {
    botServiceCredential: { findFirst },
    $queryRaw: databaseClock,
  } as unknown as PrismaService;
  const reserveOnce = input?.reservationError
    ? vi.fn().mockRejectedValue(input.reservationError)
    : vi.fn().mockResolvedValue(input?.reservation ?? true);
  const redis = { reserveOnce } as unknown as RedisService;
  const environment = {
    BOT_SIGNING_KEK:
      input && 'environmentKek' in input ? input.environmentKek : encodedKek,
  } as ApiEnvironment;
  return {
    databaseClock,
    findFirst,
    reserveOnce,
    service: new BotRequestAuthenticationService(prisma, redis, environment),
  };
}

function authenticationInput(overrides: Record<string, unknown> = {}) {
  return {
    credentialId,
    method,
    path,
    timestamp,
    nonce,
    idempotencyKey,
    telegramUserId,
    rawBody,
    signature: signature(),
    ...overrides,
  };
}

describe('BotRequestAuthenticationService', () => {
  it('authenticates the principal and Telegram identity bound into the raw-body signature', async () => {
    const { service, findFirst, databaseClock } = harness();

    await expect(service.authenticate(authenticationInput())).resolves.toEqual(
      authenticatedContext(),
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: credentialId, revokedAt: null },
      select: {
        id: true,
        principalId: true,
        keyCiphertext: true,
        nonce: true,
        keyVersion: true,
      },
    });
    expect(databaseClock).toHaveBeenCalledOnce();
  });

  it('rejects a body-only Telegram identity and does not check time after a bad signature', async () => {
    const { service, databaseClock } = harness();
    const changedBody = Buffer.from(
      JSON.stringify({ telegramUserId: '987654321', code: 'ABC' }),
    );

    await expect(
      service.authenticate(
        authenticationInput({
          rawBody: changedBody,
          telegramUserId: '987654321',
        }),
      ),
    ).resolves.toBeNull();
    expect(databaseClock).not.toHaveBeenCalled();
  });

  it('binds the idempotency key into the HMAC signature', async () => {
    const { service, databaseClock, reserveOnce } = harness();

    await expect(
      service.authenticate(
        authenticationInput({ idempotencyKey: 'attacker-replaced-key' }),
      ),
    ).resolves.toBeNull();
    expect(databaseClock).not.toHaveBeenCalled();
    expect(reserveOnce).not.toHaveBeenCalled();
  });

  it('rejects a timestamp outside the PostgreSQL clock window', async () => {
    const { service } = harness({
      databaseNow: new Date((Number(timestamp) + 31) * 1_000),
    });

    await expect(
      service.authenticate(authenticationInput()),
    ).resolves.toBeNull();
  });

  it.each([-30, 30])(
    'accepts the inclusive PostgreSQL clock boundary at %i seconds',
    async (offsetSeconds) => {
      const { service } = harness({
        databaseNow: new Date((Number(timestamp) + offsetSeconds) * 1_000),
      });

      await expect(
        service.authenticate(authenticationInput()),
      ).resolves.toEqual(authenticatedContext());
    },
  );

  it('rejects revoked or unknown credentials before cryptographic verification', async () => {
    const { service, databaseClock } = harness({ credential: null });

    await expect(
      service.authenticate(authenticationInput()),
    ).resolves.toBeNull();
    expect(databaseClock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing KEK', undefined],
    ['wrong KEK', Buffer.alloc(32, 4).toString('base64url')],
  ])('fails closed for %s', async (_scenario, environmentKek) => {
    const { service, databaseClock } = harness({ environmentKek });

    await expect(
      service.authenticate(authenticationInput()),
    ).resolves.toBeNull();
    expect(databaseClock).not.toHaveBeenCalled();
  });

  it('fails closed when the encrypted envelope is bound to another principal', async () => {
    const credential = encryptedCredential();
    credential.principalId = '33333333-3333-4333-8333-333333333333';
    const { service, databaseClock } = harness({ credential });

    await expect(
      service.authenticate(authenticationInput()),
    ).resolves.toBeNull();
    expect(databaseClock).not.toHaveBeenCalled();
  });

  it('rejects an atomically duplicated nonce after freshness validation', async () => {
    const { service, reserveOnce } = harness({ reservation: false });

    await expect(
      service.authenticate(authenticationInput()),
    ).resolves.toBeNull();
    expect(reserveOnce).toHaveBeenCalledWith(
      `bot-nonce:${principalId}:${nonce}`,
      120_000,
    );
  });

  it('rejects the same nonce even when another signed idempotency key is used', async () => {
    const changedIdempotencyKey = 'login-confirmation-2';
    const { service } = harness({ reservation: false });

    await expect(
      service.authenticate(
        authenticationInput({
          idempotencyKey: changedIdempotencyKey,
          signature: signature(rawBody, changedIdempotencyKey),
        }),
      ),
    ).resolves.toBeNull();
  });

  it('fails closed without identity when Redis cannot reserve the nonce', async () => {
    const { service } = harness({
      reservationError: new Error('redis unavailable'),
    });

    await expect(
      service.authenticate(authenticationInput()),
    ).rejects.toMatchObject({
      status: 503,
      message: 'Bot authentication is unavailable',
    });
  });
});

function authenticatedContext() {
  const input = authenticationInput();
  return {
    credentialId,
    idempotencyKey,
    method,
    path,
    principalId,
    requestHash: createBotRequestHash(input),
    telegramUserId,
  };
}
