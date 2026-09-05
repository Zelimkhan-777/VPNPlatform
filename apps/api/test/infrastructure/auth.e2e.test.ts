import {
  ServiceUnavailableException,
  type INestApplication,
} from '@nestjs/common';
import {
  BOT_AUTH_HEADER_NAMES,
  createBotRequestCanonicalString,
  readinessResponseSchema,
} from '@vpn-platform/contracts';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { BotRequestAuthenticationService } from '../../src/auth/bot-request-authentication.service';
import { BotAuthChallengeService } from '../../src/auth/bot-auth-challenge.service';
import { BotRequestExecutionService } from '../../src/auth/bot-request-execution.service';
import {
  hashConfirmationCode,
  hashPendingSecret,
  PendingLoginService,
} from '../../src/auth/pending-login.service';
import {
  provisionBotCredential,
  revokeBotCredential,
  rotateBotCredential,
} from '../../src/auth/bot-credential-lifecycle';
import { encryptBotSigningKey } from '../../src/auth/bot-signing-key';
import { TrustedPrelaunchService } from '../../src/auth/trusted-prelaunch.service';
import { API_ENVIRONMENT } from '../../src/config/environment';
import { PrismaService } from '../../src/database/prisma.service';
import { RedisService } from '../../src/redis/redis.service';
import {
  authSessionPepper,
  botSigningKek,
  createInfrastructureTestApp,
  signedTelegramInitData,
} from './fixture';

async function signedBotHttpRequest(
  prisma: PrismaService,
  input: {
    body: Record<string, string>;
    credentialId: string;
    idempotencyKey: string;
    path: string;
    signingKey: Buffer;
  },
): Promise<{ headers: Record<string, string>; rawBody: string }> {
  const rawBody = JSON.stringify(input.body);
  const databaseClock = await prisma.$queryRaw<{ now: Date }[]>`
    SELECT clock_timestamp() AS "now"
  `;
  const timestamp = String(
    Math.floor((databaseClock[0]?.now.getTime() ?? 0) / 1_000),
  );
  const nonce = randomUUID().replaceAll('-', '');
  const canonical = createBotRequestCanonicalString({
    credentialId: input.credentialId,
    method: 'POST',
    path: input.path,
    timestamp,
    nonce,
    telegramUserId: input.body.telegramUserId ?? '',
    idempotencyKey: input.idempotencyKey,
    rawBodySha256: createHash('sha256').update(rawBody).digest('hex'),
  });
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      [BOT_AUTH_HEADER_NAMES.credentialId]: input.credentialId,
      [BOT_AUTH_HEADER_NAMES.idempotencyKey]: input.idempotencyKey,
      [BOT_AUTH_HEADER_NAMES.nonce]: nonce,
      [BOT_AUTH_HEADER_NAMES.signature]: createHmac('sha256', input.signingKey)
        .update(canonical)
        .digest('hex'),
      [BOT_AUTH_HEADER_NAMES.timestamp]: timestamp,
    },
  };
}

describe('infrastructure auth', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createInfrastructureTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('executes PostgreSQL SELECT 1 and Redis PING through readiness', async () => {
    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);

    expect(readinessResponseSchema.parse(response.body)).toEqual({
      status: 'ready',
      dependencies: { postgres: 'up', redis: 'up' },
    });
  });

  it('issues an idempotent user-bound challenge only after confirmed entitlement', async () => {
    const prisma = app.get(PrismaService);
    const challenges = app.get(BotAuthChallengeService);
    const principalId = randomUUID();
    const credentialId = randomUUID();
    const userTelegramId = `6${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const userWithoutEntitlementTelegramId = `5${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const requestContext = {
      credentialId,
      principalId,
      telegramUserId: userTelegramId,
      method: 'POST',
      path: '/auth/telegram/challenge',
      idempotencyKey: `issuer-${randomUUID()}`,
      requestHash: 'c'.repeat(64),
    };
    const encrypted = encryptBotSigningKey(
      Buffer.alloc(32, 51),
      botSigningKek,
      { credentialId, principalId, keyVersion: 1 },
      Buffer.alloc(12, 51),
    );
    let userId: string | undefined;
    let userWithoutEntitlementId: string | undefined;
    let planId: string | undefined;

    try {
      await prisma.botServicePrincipal.create({
        data: {
          id: principalId,
          name: `issuer-bot-${principalId}`,
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
      const plan = await prisma.plan.create({
        data: {
          code: `issuer-${randomUUID()}`,
          name: 'Issuer integration plan',
          priceMinor: 1,
          currency: 'RUB',
          durationDays: 30,
          deviceLimit: 1,
        },
      });
      planId = plan.id;
      const [user, userWithoutEntitlement] = await prisma.$transaction([
        prisma.user.create({ data: { telegramUserId: userTelegramId } }),
        prisma.user.create({
          data: { telegramUserId: userWithoutEntitlementTelegramId },
        }),
      ]);
      userId = user.id;
      userWithoutEntitlementId = userWithoutEntitlement.id;
      await prisma.subscription.create({
        data: {
          userId: user.id,
          planId: plan.id,
          status: 'EXPIRED',
          startsAt: new Date('2026-08-01T00:00:00.000Z'),
          expiresAt: new Date('2026-08-02T00:00:00.000Z'),
        },
      });

      const first = await challenges.issue(requestContext);
      const retry = await challenges.issue(requestContext);
      expect(retry).toEqual(first);

      const stored = await prisma.authChallenge.findUniqueOrThrow({
        where: { launchId: first.launchId },
      });
      expect(stored.userId).toBe(user.id);
      expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(
        120_000,
      );
      await expect(
        prisma.authChallenge.count({ where: { userId: user.id } }),
      ).resolves.toBe(1);

      await expect(
        challenges.issue({
          ...requestContext,
          telegramUserId: userWithoutEntitlementTelegramId,
          idempotencyKey: `issuer-denied-${randomUUID()}`,
          requestHash: 'd'.repeat(64),
        }),
      ).rejects.toThrow('Cabinet access is unavailable');
      await expect(
        prisma.authChallenge.count({
          where: { userId: userWithoutEntitlement.id },
        }),
      ).resolves.toBe(0);
    } finally {
      if (userId) {
        await prisma.authChallenge.deleteMany({ where: { userId } });
        await prisma.subscription.deleteMany({ where: { userId } });
      }
      if (userWithoutEntitlementId) {
        await prisma.authChallenge.deleteMany({
          where: { userId: userWithoutEntitlementId },
        });
      }
      await prisma.botRequestIdempotency.deleteMany({
        where: { principalId },
      });
      await prisma.botServiceCredential.deleteMany({ where: { principalId } });
      await prisma.botServicePrincipal.deleteMany({
        where: { id: principalId },
      });
      if (userId || userWithoutEntitlementId) {
        await prisma.user.deleteMany({
          where: {
            id: {
              in: [userId, userWithoutEntitlementId].filter(
                (id): id is string => id !== undefined,
              ),
            },
          },
        });
      }
      if (planId) await prisma.plan.deleteMany({ where: { id: planId } });
    }
  });

  it('confirms a browser-bound pending login and atomically completes one session', async () => {
    const prisma = app.get(PrismaService);
    const pendingLogins = app.get(PendingLoginService);
    const principalId = randomUUID();
    const credentialId = randomUUID();
    const signingKey = Buffer.alloc(32, 73);
    const userId = randomUUID();
    const challengeId = randomUUID();
    const telegramUserId = `7${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const launchId = Buffer.alloc(32, 71).toString('base64url');
    const databaseClock = await prisma.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS "now"
    `;
    const now = databaseClock[0]?.now;
    if (!now) throw new Error('PostgreSQL clock is unavailable');
    const encrypted = encryptBotSigningKey(
      signingKey,
      botSigningKek,
      { credentialId, principalId, keyVersion: 1 },
      Buffer.alloc(12, 73),
    );

    try {
      await prisma.botServicePrincipal.create({
        data: {
          id: principalId,
          name: `pending-login-bot-${principalId}`,
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
      await prisma.user.create({
        data: { id: userId, telegramUserId },
      });
      await prisma.authChallenge.create({
        data: {
          id: challengeId,
          userId,
          launchId,
          tokenHash: createHash('sha256')
            .update(`pending-login-${challengeId}`)
            .digest('hex'),
          createdAt: now,
          expiresAt: new Date(now.getTime() + 120_000),
        },
      });

      const begun = await pendingLogins.begin(
        signedTelegramInitData(
          telegramUserId,
          launchId,
          randomUUID(),
          Math.floor(now.getTime() / 1_000),
        ),
        now,
      );
      const confirmationBody = {
        telegramUserId,
        confirmationCode: begun.pending.confirmationCode,
      };
      const failedIdempotencyKey = `redis-failed-confirm-${randomUUID()}`;
      const failedConfirmation = await signedBotHttpRequest(prisma, {
        body: confirmationBody,
        credentialId,
        path: '/auth/telegram/confirm',
        idempotencyKey: failedIdempotencyKey,
        signingKey,
      });
      const redisRateLimitFailure = vi
        .spyOn(app.get(RedisService), 'incrementWithExpiry')
        .mockRejectedValueOnce(new Error('Redis unavailable'));
      try {
        await request(app.getHttpServer())
          .post('/auth/telegram/confirm')
          .set(failedConfirmation.headers)
          .send(failedConfirmation.rawBody)
          .expect(503);
      } finally {
        redisRateLimitFailure.mockRestore();
      }
      await expect(
        prisma.botRequestIdempotency.count({
          where: { principalId, idempotencyKey: failedIdempotencyKey },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.pendingLogin.findUniqueOrThrow({
          where: {
            pendingTokenHash: hashPendingSecret(
              begun.secret,
              authSessionPepper,
            ),
          },
          select: { status: true, confirmedAt: true },
        }),
      ).resolves.toEqual({
        status: 'AWAITING_BOT_CONFIRM',
        confirmedAt: null,
      });
      const confirmationIdempotencyKey = `pending-confirm-${randomUUID()}`;
      const firstConfirmation = await signedBotHttpRequest(prisma, {
        body: confirmationBody,
        credentialId,
        path: '/auth/telegram/confirm',
        idempotencyKey: confirmationIdempotencyKey,
        signingKey,
      });
      const confirm = () =>
        request(app.getHttpServer())
          .post('/auth/telegram/confirm')
          .set(firstConfirmation.headers)
          .send(firstConfirmation.rawBody);

      const beforeConfirmation = await request(app.getHttpServer())
        .post('/auth/telegram/complete')
        .set('origin', 'https://app.example.test')
        .set('x-forwarded-for', '192.0.2.18')
        .set('cookie', `vpn_platform_pending_login=${begun.secret}`)
        .expect(401);
      expect(beforeConfirmation.headers['set-cookie']).toBeUndefined();

      const wrongCode = await signedBotHttpRequest(prisma, {
        body: { ...confirmationBody, confirmationCode: '01AB2CD3' },
        credentialId,
        path: '/auth/telegram/confirm',
        idempotencyKey: `wrong-code-${randomUUID()}`,
        signingKey,
      });
      await request(app.getHttpServer())
        .post('/auth/telegram/confirm')
        .set(wrongCode.headers)
        .send(wrongCode.rawBody)
        .expect(401);
      const wrongIdentity = await signedBotHttpRequest(prisma, {
        body: {
          ...confirmationBody,
          telegramUserId: `6${telegramUserId.slice(1)}`,
        },
        credentialId,
        path: '/auth/telegram/confirm',
        idempotencyKey: `wrong-identity-${randomUUID()}`,
        signingKey,
      });
      await request(app.getHttpServer())
        .post('/auth/telegram/confirm')
        .set(wrongIdentity.headers)
        .send(wrongIdentity.rawBody)
        .expect(401);
      await expect(
        prisma.pendingLogin.findUniqueOrThrow({
          where: {
            pendingTokenHash: hashPendingSecret(
              begun.secret,
              authSessionPepper,
            ),
          },
          select: { status: true, confirmedAt: true },
        }),
      ).resolves.toEqual({
        status: 'AWAITING_BOT_CONFIRM',
        confirmedAt: null,
      });

      const collisionChallengeId = randomUUID();
      await prisma.authChallenge.create({
        data: {
          id: collisionChallengeId,
          userId,
          launchId: Buffer.alloc(32, 72).toString('base64url'),
          tokenHash: createHash('sha256')
            .update(`pending-login-${collisionChallengeId}`)
            .digest('hex'),
          createdAt: now,
          expiresAt: new Date(now.getTime() + 120_000),
        },
      });
      const [confirmationResponse, collisionInsert] = await Promise.all([
        confirm(),
        prisma.pendingLogin
          .create({
            data: {
              challengeId: collisionChallengeId,
              userId,
              telegramUserId,
              pendingTokenHash: createHash('sha256')
                .update(`duplicate-pending-${collisionChallengeId}`)
                .digest('hex'),
              confirmationCodeHash: hashConfirmationCode(
                telegramUserId,
                begun.pending.confirmationCode,
                authSessionPepper,
              ),
              createdAt: now,
              expiresAt: new Date(now.getTime() + 120_000),
            },
          })
          .then(
            () => ({ status: 'fulfilled' as const }),
            (reason: unknown) => ({ status: 'rejected' as const, reason }),
          ),
      ]);
      expect(confirmationResponse.status).toBe(200);
      expect(confirmationResponse.body).toEqual({ status: 'BOT_CONFIRMED' });
      expect(collisionInsert.status).toBe('rejected');
      expect(
        (collisionInsert as { reason: { code?: string } }).reason.code,
      ).toBe('P2002');
      const replayConfirmation = await signedBotHttpRequest(prisma, {
        body: confirmationBody,
        credentialId,
        path: '/auth/telegram/confirm',
        idempotencyKey: confirmationIdempotencyKey,
        signingKey,
      });
      await request(app.getHttpServer())
        .post('/auth/telegram/confirm')
        .set(replayConfirmation.headers)
        .send(replayConfirmation.rawBody)
        .expect(200)
        .expect({ status: 'BOT_CONFIRMED' });
      const conflictingConfirmation = await signedBotHttpRequest(prisma, {
        body: { ...confirmationBody, confirmationCode: '01AB2CD3' },
        credentialId,
        path: '/auth/telegram/confirm',
        idempotencyKey: confirmationIdempotencyKey,
        signingKey,
      });
      await request(app.getHttpServer())
        .post('/auth/telegram/confirm')
        .set(conflictingConfirmation.headers)
        .send(conflictingConfirmation.rawBody)
        .expect(409);

      for (const origin of [
        undefined,
        'https://attacker.example.test',
        'https://sibling.app.example.test',
      ]) {
        const attempt = request(app.getHttpServer()).post(
          '/auth/telegram/complete',
        );
        if (origin) attempt.set('origin', origin);
        const denied = await attempt
          .set('x-forwarded-for', '192.0.2.19')
          .set('cookie', `vpn_platform_pending_login=${begun.secret}`)
          .expect(403);
        expect(denied.headers['set-cookie']).toBeUndefined();
      }
      for (const [cookie, ip] of [
        [undefined, '192.0.2.20'],
        ['vpn_platform_pending_login=invalid', '192.0.2.21'],
      ] as const) {
        const attempt = request(app.getHttpServer())
          .post('/auth/telegram/complete')
          .set('origin', 'https://app.example.test')
          .set('x-forwarded-for', ip);
        if (cookie) attempt.set('cookie', cookie);
        const denied = await attempt.expect(401);
        expect(denied.headers['set-cookie']).toBeUndefined();
      }

      const completeRedisFailure = vi
        .spyOn(app.get(RedisService), 'incrementWithExpiry')
        .mockRejectedValueOnce(new Error('Redis unavailable'));
      try {
        const unavailable = await request(app.getHttpServer())
          .post('/auth/telegram/complete')
          .set('origin', 'https://app.example.test')
          .set('x-forwarded-for', '192.0.2.24')
          .set('cookie', `vpn_platform_pending_login=${begun.secret}`)
          .expect(503);
        expect(unavailable.headers['set-cookie']).toBeUndefined();
      } finally {
        completeRedisFailure.mockRestore();
      }
      await expect(
        prisma.pendingLogin.findUniqueOrThrow({
          where: {
            pendingTokenHash: hashPendingSecret(
              begun.secret,
              authSessionPepper,
            ),
          },
          select: { status: true, consumedAt: true },
        }),
      ).resolves.toEqual({ status: 'BOT_CONFIRMED', consumedAt: null });
      await expect(
        prisma.userSession.count({ where: { userId } }),
      ).resolves.toBe(0);

      const completes = await Promise.all(
        ['192.0.2.22', '192.0.2.23'].map((ip) =>
          request(app.getHttpServer())
            .post('/auth/telegram/complete')
            .set('origin', 'https://app.example.test')
            .set('x-forwarded-for', ip)
            .set('cookie', `vpn_platform_pending_login=${begun.secret}`),
        ),
      );
      expect(completes.map((item) => item.status).sort()).toEqual([200, 401]);
      const response = completes.find((item) => item.status === 200);
      if (!response) throw new Error('Successful completion is missing');
      expect(response.headers['set-cookie']).toEqual([
        expect.stringContaining('vpn_platform_session='),
        expect.stringContaining('vpn_platform_pending_login=;'),
      ]);
      expect(response.body.user).toEqual({ id: userId, role: 'CUSTOMER' });
      const sessionCookie = response.headers['set-cookie']?.[0];
      if (!sessionCookie) throw new Error('Session cookie is missing');
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('cookie', sessionCookie)
        .expect(200)
        .expect(({ body }) => {
          expect(body.user).toEqual({ id: userId, role: 'CUSTOMER' });
        });
      await expect(
        prisma.userSession.count({ where: { userId } }),
      ).resolves.toBe(1);
      await expect(
        prisma.pendingLogin.findUniqueOrThrow({
          where: {
            pendingTokenHash: hashPendingSecret(
              begun.secret,
              authSessionPepper,
            ),
          },
          select: { status: true, consumedAt: true },
        }),
      ).resolves.toMatchObject({
        status: 'CONSUMED',
        consumedAt: expect.any(Date),
      });
      await expect(
        prisma.authChallenge.findUniqueOrThrow({
          where: { id: challengeId },
          select: { consumedAt: true, sessionId: true },
        }),
      ).resolves.toMatchObject({
        consumedAt: expect.any(Date),
        sessionId: expect.any(String),
      });
      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('origin', 'https://app.example.test')
        .set('cookie', sessionCookie)
        .expect(204);
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('cookie', sessionCookie)
        .expect(401);
    } finally {
      await prisma.pendingLogin.deleteMany({ where: { userId } });
      await prisma.authChallenge.deleteMany({ where: { userId } });
      await prisma.userSession.deleteMany({ where: { userId } });
      await prisma.botRequestIdempotency.deleteMany({
        where: { principalId },
      });
      await prisma.botServiceCredential.deleteMany({ where: { principalId } });
      await prisma.botServicePrincipal.deleteMany({
        where: { id: principalId },
      });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it('rejects expired pending and challenge states without creating cookies or sessions', async () => {
    const prisma = app.get(PrismaService);
    const userId = randomUUID();
    const telegramUserId = `3${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const nowRows = await prisma.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS "now"
    `;
    const now = nowRows[0]?.now;
    if (!now) throw new Error('PostgreSQL clock is unavailable');
    const challengeIds = [randomUUID(), randomUUID()];
    const pendingSecrets = [Buffer.alloc(32, 81), Buffer.alloc(32, 82)].map(
      (value) => value.toString('base64url'),
    );

    try {
      await prisma.user.create({ data: { id: userId, telegramUserId } });
      await prisma.authChallenge.createMany({
        data: challengeIds.map((id, index) => ({
          id,
          userId,
          launchId: Buffer.alloc(32, 83 + index).toString('base64url'),
          tokenHash: createHash('sha256')
            .update(`expired-state-${id}`)
            .digest('hex'),
          createdAt: new Date(now.getTime() - 120_000),
          expiresAt:
            index === 0
              ? new Date(now.getTime() + 120_000)
              : new Date(now.getTime() - 30_000),
        })),
      });
      await prisma.pendingLogin.createMany({
        data: challengeIds.map((challengeId, index) => ({
          challengeId,
          userId,
          telegramUserId,
          pendingTokenHash: hashPendingSecret(
            pendingSecrets[index] ?? '',
            authSessionPepper,
          ),
          confirmationCodeHash: hashConfirmationCode(
            telegramUserId,
            index === 0 ? '01AB2CD3' : '45EF6GH7',
            authSessionPepper,
          ),
          status: 'BOT_CONFIRMED',
          createdAt: new Date(now.getTime() - 120_000),
          confirmedAt: new Date(now.getTime() - 60_000),
          expiresAt:
            index === 0
              ? new Date(now.getTime() - 30_000)
              : new Date(now.getTime() + 60_000),
        })),
      });

      for (const [index, secret] of pendingSecrets.entries()) {
        const denied = await request(app.getHttpServer())
          .post('/auth/telegram/complete')
          .set('origin', 'https://app.example.test')
          .set('x-forwarded-for', `192.0.2.${30 + index}`)
          .set('cookie', `vpn_platform_pending_login=${secret}`)
          .expect(401);
        expect(denied.headers['set-cookie']).toBeUndefined();
      }
      await expect(
        prisma.userSession.count({ where: { userId } }),
      ).resolves.toBe(0);
      await expect(
        prisma.pendingLogin.count({
          where: { userId, status: 'BOT_CONFIRMED', consumedAt: null },
        }),
      ).resolves.toBe(2);
    } finally {
      await prisma.pendingLogin.deleteMany({ where: { userId } });
      await prisma.authChallenge.deleteMany({ where: { userId } });
      await prisma.userSession.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it('keeps two browser pending records isolated to the confirmed cookie', async () => {
    const prisma = app.get(PrismaService);
    const pendingLogins = app.get(PendingLoginService);
    const principalId = randomUUID();
    const credentialId = randomUUID();
    const signingKey = Buffer.alloc(32, 91);
    const userId = randomUUID();
    const telegramUserId = `2${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const launchId = Buffer.alloc(32, 92).toString('base64url');
    const nowRows = await prisma.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS "now"
    `;
    const now = nowRows[0]?.now;
    if (!now) throw new Error('PostgreSQL clock is unavailable');
    const encrypted = encryptBotSigningKey(
      signingKey,
      botSigningKek,
      { credentialId, principalId, keyVersion: 1 },
      Buffer.alloc(12, 91),
    );

    try {
      await prisma.botServicePrincipal.create({
        data: {
          id: principalId,
          name: `two-browser-bot-${principalId}`,
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
      await prisma.user.create({ data: { id: userId, telegramUserId } });
      await prisma.authChallenge.create({
        data: {
          userId,
          launchId,
          tokenHash: createHash('sha256')
            .update(`two-browser-${launchId}`)
            .digest('hex'),
          createdAt: now,
          expiresAt: new Date(now.getTime() + 120_000),
        },
      });
      const initData = signedTelegramInitData(
        telegramUserId,
        launchId,
        randomUUID(),
        Math.floor(now.getTime() / 1_000),
      );
      const [first, second] = await Promise.all([
        pendingLogins.begin(initData, now),
        pendingLogins.begin(initData, now),
      ]);
      expect(first.pending.confirmationCode).not.toBe(
        second.pending.confirmationCode,
      );
      const signedConfirmation = await signedBotHttpRequest(prisma, {
        body: {
          telegramUserId,
          confirmationCode: first.pending.confirmationCode,
        },
        credentialId,
        idempotencyKey: `two-browser-${randomUUID()}`,
        path: '/auth/telegram/confirm',
        signingKey,
      });
      await request(app.getHttpServer())
        .post('/auth/telegram/confirm')
        .set(signedConfirmation.headers)
        .send(signedConfirmation.rawBody)
        .expect(200);

      const unconfirmedBrowser = await request(app.getHttpServer())
        .post('/auth/telegram/complete')
        .set('origin', 'https://app.example.test')
        .set('x-forwarded-for', '192.0.2.40')
        .set('cookie', `vpn_platform_pending_login=${second.secret}`)
        .expect(401);
      expect(unconfirmedBrowser.headers['set-cookie']).toBeUndefined();
      await request(app.getHttpServer())
        .post('/auth/telegram/complete')
        .set('origin', 'https://app.example.test')
        .set('x-forwarded-for', '192.0.2.41')
        .set('cookie', `vpn_platform_pending_login=${first.secret}`)
        .expect(200);
      await expect(
        prisma.userSession.count({ where: { userId } }),
      ).resolves.toBe(1);
    } finally {
      await prisma.pendingLogin.deleteMany({ where: { userId } });
      await prisma.authChallenge.deleteMany({ where: { userId } });
      await prisma.userSession.deleteMany({ where: { userId } });
      await prisma.botRequestIdempotency.deleteMany({
        where: { principalId },
      });
      await prisma.botServiceCredential.deleteMany({ where: { principalId } });
      await prisma.botServicePrincipal.deleteMany({
        where: { id: principalId },
      });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it('authenticates an encrypted bot credential against PostgreSQL clock and rejects it after revoke', async () => {
    const prisma = app.get(PrismaService);
    const authentication = app.get(BotRequestAuthenticationService);
    const principalId = randomUUID();
    const credentialId = randomUUID();
    const signingKey = Buffer.alloc(32, 31);
    const body = Buffer.from(
      JSON.stringify({ telegramUserId: '123456789', command: 'probe' }),
    );
    const encrypted = encryptBotSigningKey(
      signingKey,
      botSigningKek,
      { credentialId, principalId, keyVersion: 1 },
      Buffer.alloc(12, 17),
    );

    try {
      await prisma.botServicePrincipal.create({
        data: {
          id: principalId,
          name: `integration-bot-${principalId}`,
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
      const databaseClock = await prisma.$queryRaw<{ now: Date }[]>`
        SELECT clock_timestamp() AS "now"
      `;
      const timestamp = String(
        Math.floor((databaseClock[0]?.now.getTime() ?? 0) / 1_000),
      );
      const createInput = (nonce: string) => {
        const canonical = {
          credentialId,
          method: 'POST',
          path: '/internal/bot/probe',
          timestamp,
          nonce,
          telegramUserId: '123456789',
          idempotencyKey: 'integration-probe-1',
          rawBodySha256: createHash('sha256').update(body).digest('hex'),
        };
        return {
          ...canonical,
          rawBody: body,
          signature: createHmac('sha256', signingKey)
            .update(createBotRequestCanonicalString(canonical))
            .digest('hex'),
        };
      };
      const input = createInput('integration-nonce');

      await expect(authentication.authenticate(input)).resolves.toMatchObject({
        credentialId,
        principalId,
        telegramUserId: '123456789',
      });
      await expect(authentication.authenticate(input)).resolves.toBeNull();
      await expect(
        authentication.authenticate(createInput('integration-nonce-retry')),
      ).resolves.toMatchObject({
        credentialId,
        principalId,
        idempotencyKey: 'integration-probe-1',
      });
      await prisma.botServiceCredential.update({
        where: { id: credentialId },
        data: { revokedAt: new Date() },
      });
      await expect(
        authentication.authenticate(createInput('integration-nonce-revoked')),
      ).resolves.toBeNull();
    } finally {
      signingKey.fill(0);
      await prisma.botServiceCredential.deleteMany({ where: { principalId } });
      await prisma.botServicePrincipal.deleteMany({
        where: { id: principalId },
      });
    }
  });

  it('serializes principal-scoped idempotency across credentials and rejects a changed request', async () => {
    const prisma = app.get(PrismaService);
    const execution = app.get(BotRequestExecutionService);
    const principalId = randomUUID();
    const firstCredentialId = randomUUID();
    const secondCredentialId = randomUUID();
    const userTelegramId = `7${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const requestContext = {
      credentialId: firstCredentialId,
      principalId,
      telegramUserId: userTelegramId,
      method: 'POST',
      path: '/internal/bot/idempotency-probe',
      idempotencyKey: 'integration-idempotency-1',
      requestHash: 'a'.repeat(64),
    };
    let operationCount = 0;
    const firstEncrypted = encryptBotSigningKey(
      Buffer.alloc(32, 41),
      botSigningKek,
      { credentialId: firstCredentialId, principalId, keyVersion: 1 },
      Buffer.alloc(12, 41),
    );
    const secondEncrypted = encryptBotSigningKey(
      Buffer.alloc(32, 42),
      botSigningKek,
      { credentialId: secondCredentialId, principalId, keyVersion: 2 },
      Buffer.alloc(12, 42),
    );

    try {
      await prisma.botServicePrincipal.create({
        data: {
          id: principalId,
          name: `idempotency-bot-${principalId}`,
          credentials: {
            create: [
              {
                id: firstCredentialId,
                keyCiphertext: firstEncrypted.keyCiphertext,
                nonce: firstEncrypted.nonce,
                keyVersion: 1,
              },
              {
                id: secondCredentialId,
                keyCiphertext: secondEncrypted.keyCiphertext,
                nonce: secondEncrypted.nonce,
                keyVersion: 2,
              },
            ],
          },
        },
      });
      const operation = async (
        transaction: Parameters<
          Parameters<BotRequestExecutionService['execute']>[1]
        >[0],
      ) => {
        operationCount += 1;
        await transaction.$queryRaw`
          SELECT 1::integer AS "slept"
          FROM pg_sleep(0.1)
        `;
        const user = await transaction.user.create({
          data: { telegramUserId: userTelegramId },
          select: { id: true },
        });
        return { statusCode: 201, body: { userId: user.id } };
      };

      const results = await Promise.all([
        execution.execute(requestContext, operation),
        execution.execute(
          { ...requestContext, credentialId: secondCredentialId },
          operation,
        ),
      ]);
      expect(results.map((result) => result.replayed).sort()).toEqual([
        false,
        true,
      ]);
      expect(results[0]?.body).toEqual(results[1]?.body);
      expect(operationCount).toBe(1);
      expect(
        await prisma.user.count({ where: { telegramUserId: userTelegramId } }),
      ).toBe(1);
      expect(
        await prisma.botRequestIdempotency.count({ where: { principalId } }),
      ).toBe(1);
      await expect(
        execution.execute(
          { ...requestContext, requestHash: 'b'.repeat(64) },
          operation,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(operationCount).toBe(1);
    } finally {
      await prisma.botRequestIdempotency.deleteMany({ where: { principalId } });
      await prisma.user.deleteMany({
        where: { telegramUserId: userTelegramId },
      });
      await prisma.botServiceCredential.deleteMany({
        where: { principalId },
      });
      await prisma.botServicePrincipal.deleteMany({
        where: { id: principalId },
      });
    }
  });

  it('provisions, overlaps, revokes and safely reprovisions bot credentials with audit', async () => {
    const prisma = app.get(PrismaService);
    const principalName = `credential-lifecycle-${randomUUID()}`;
    const reason = 'Integration lifecycle verification';
    let first: Awaited<ReturnType<typeof provisionBotCredential>> | undefined;
    let second: Awaited<ReturnType<typeof rotateBotCredential>> | undefined;
    let third: Awaited<ReturnType<typeof rotateBotCredential>> | undefined;
    let recovered:
      Awaited<ReturnType<typeof provisionBotCredential>> | undefined;
    try {
      first = await provisionBotCredential(prisma, botSigningKek, {
        principalName,
        reason,
      });
      await expect(
        prisma.botServiceCredential.create({
          data: {
            principalId: first.principalId,
            keyCiphertext: 'duplicate-version-test',
            nonce: 'duplicate-version-test',
            keyVersion: first.keyVersion,
          },
        }),
      ).rejects.toThrow();
      second = await rotateBotCredential(prisma, botSigningKek, {
        principalName,
        reason,
      });
      expect(second.principalId).toBe(first.principalId);
      expect(second.keyVersion).toBe(2);
      expect(
        await prisma.botServiceCredential.count({
          where: { principalId: first.principalId, revokedAt: null },
        }),
      ).toBe(2);
      await expect(
        rotateBotCredential(prisma, botSigningKek, {
          principalName,
          reason: 'Must finish the existing overlap first',
        }),
      ).rejects.toThrow(
        'Bot credential rotation requires exactly one active credential',
      );
      expect(
        await prisma.botServiceCredential.count({
          where: { principalId: first.principalId, revokedAt: null },
        }),
      ).toBe(2);

      await expect(
        revokeBotCredential(prisma, {
          principalName,
          reason,
          keyVersion: 1,
          protectedCredentialId: second.credentialId,
        }),
      ).resolves.toEqual({ changed: true, keyVersion: 1 });
      await expect(
        revokeBotCredential(prisma, {
          principalName,
          reason,
          keyVersion: 1,
          protectedCredentialId: second.credentialId,
        }),
      ).resolves.toEqual({ changed: false, keyVersion: 1 });
      third = await rotateBotCredential(prisma, botSigningKek, {
        principalName,
        reason: 'Rotate after completing the previous overlap',
      });
      expect(third.keyVersion).toBe(3);
      await expect(
        revokeBotCredential(prisma, {
          principalName,
          reason,
          keyVersion: 2,
          protectedCredentialId: third.credentialId,
        }),
      ).resolves.toEqual({ changed: true, keyVersion: 2 });
      await expect(
        revokeBotCredential(prisma, {
          principalName,
          reason,
          keyVersion: 3,
        }),
      ).resolves.toEqual({ changed: true, keyVersion: 3 });
      recovered = await provisionBotCredential(prisma, botSigningKek, {
        principalName,
        reason: 'Recover after credential file installation failure',
      });
      expect(recovered.principalId).toBe(first.principalId);
      expect(recovered.keyVersion).toBe(4);
      expect(
        await prisma.auditEvent.count({
          where: {
            entityType: 'BotServiceCredential',
            entityId: {
              in: [
                first.credentialId,
                second.credentialId,
                third.credentialId,
                recovered.credentialId,
              ],
            },
          },
        }),
      ).toBe(7);
    } finally {
      first?.signingKey.fill(0);
      second?.signingKey.fill(0);
      third?.signingKey.fill(0);
      recovered?.signingKey.fill(0);
      const principal = await prisma.botServicePrincipal.findUnique({
        where: { name: principalName },
        select: { id: true },
      });
      if (principal) {
        await prisma.botServiceCredential.deleteMany({
          where: { principalId: principal.id },
        });
        await prisma.botServicePrincipal.delete({
          where: { id: principal.id },
        });
      }
    }
  });

  it('binds Telegram replay retries to one challenge cookie and revokes logout sessions', async () => {
    const prisma = app.get(PrismaService);
    const telegramUserId = `8${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const prelaunch = app.get(TrustedPrelaunchService);
    const context = await prelaunch.issue(`test-${randomUUID()}`);
    const initData = signedTelegramInitData(telegramUserId, context.launchId);
    let userId: string | undefined;

    try {
      const challengeCookie = `vpn_platform_prelaunch=${context.secret}`;

      const first = await request(app.getHttpServer())
        .post('/auth/telegram')
        .set('cookie', challengeCookie)
        .send({ initData })
        .expect(200);
      const sessionCookie = first.headers['set-cookie']?.[0];
      expect(sessionCookie).toContain('vpn_platform_session=');
      if (!sessionCookie) throw new Error('Session cookie is missing');
      userId = first.body.user.id;

      const retry = await request(app.getHttpServer())
        .post('/auth/telegram')
        .set('cookie', challengeCookie)
        .send({ initData })
        .expect(200);
      expect(retry.headers['set-cookie']?.[0]).toBe(sessionCookie);

      const attacker = await request(app.getHttpServer())
        .post('/auth/telegram')
        .set('cookie', `vpn_platform_prelaunch=${'b'.repeat(43)}`)
        .send({ initData })
        .expect(401);
      expect(attacker.headers['set-cookie']).toBeUndefined();

      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('cookie', sessionCookie)
        .set('origin', 'https://app.example.test')
        .expect('cache-control', 'no-store')
        .expect('set-cookie', /Max-Age=0/)
        .expect(204);
      const retryAfterLogout = await request(app.getHttpServer())
        .post('/auth/telegram')
        .set('cookie', challengeCookie)
        .send({ initData })
        .expect(401);
      expect(retryAfterLogout.headers['set-cookie']).toBeUndefined();
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('cookie', sessionCookie)
        .expect(401);
      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('cookie', sessionCookie)
        .set('origin', 'https://app.example.test')
        .expect(204);
    } finally {
      if (userId) {
        await prisma.authChallenge.deleteMany({ where: { userId } });
        await prisma.userSession.deleteMany({ where: { userId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    }
  });

  it('allows no second session for concurrent trusted contexts of one Telegram proof', async () => {
    const prisma = app.get(PrismaService);
    const prelaunch = app.get(TrustedPrelaunchService);
    const telegramUserId = `9${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const queryId = randomUUID();
    const [first, second] = await Promise.all([
      prelaunch.issue(`same-proof-first-${randomUUID()}`),
      prelaunch.issue(`same-proof-second-${randomUUID()}`),
    ]);
    try {
      const responses = await Promise.all([
        request(app.getHttpServer())
          .post('/auth/telegram')
          .set('cookie', `vpn_platform_prelaunch=${first.secret}`)
          .send({
            initData: signedTelegramInitData(
              telegramUserId,
              first.launchId,
              queryId,
            ),
          }),
        request(app.getHttpServer())
          .post('/auth/telegram')
          .set('cookie', `vpn_platform_prelaunch=${second.secret}`)
          .send({
            initData: signedTelegramInitData(
              telegramUserId,
              second.launchId,
              queryId,
            ),
          }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 401,
      ]);
      const user = await prisma.user.findUniqueOrThrow({
        where: { telegramUserId },
      });
      await expect(
        prisma.userSession.count({ where: { userId: user.id } }),
      ).resolves.toBe(1);
      await prisma.authChallenge.deleteMany({ where: { userId: user.id } });
      await prisma.userSession.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    } finally {
      await prisma.authChallenge.deleteMany({
        where: { launchId: { in: [first.launchId, second.launchId] } },
      });
    }
  });

  it('returns one generic HTTP error for invalid Telegram proof and context variants', async () => {
    const prisma = app.get(PrismaService);
    const prelaunch = app.get(TrustedPrelaunchService);
    const context = await prelaunch.issue(`generic-auth-error-${randomUUID()}`);
    const telegramUserId = `4${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const valid = signedTelegramInitData(telegramUserId, context.launchId);
    const forgedParameters = new URLSearchParams(valid);
    forgedParameters.set('hash', '0'.repeat(64));
    const cases = [
      {
        name: 'forged proof',
        cookie: context.secret,
        initData: forgedParameters.toString(),
      },
      {
        name: 'expired proof',
        cookie: context.secret,
        initData: signedTelegramInitData(
          telegramUserId,
          context.launchId,
          randomUUID(),
          Math.floor(Date.now() / 1_000) - 3_601,
        ),
      },
      {
        name: 'wrong pre-launch secret',
        cookie: 'c'.repeat(43),
        initData: valid,
      },
      {
        name: 'wrong signed start_param',
        cookie: context.secret,
        initData: signedTelegramInitData(telegramUserId, 'd'.repeat(43)),
      },
    ];

    try {
      for (const { name, cookie, initData } of cases) {
        const response = await request(app.getHttpServer())
          .post('/auth/telegram')
          .set('cookie', `vpn_platform_prelaunch=${cookie}`)
          .send({ initData });
        expect(response.status, name).toBe(401);
        expect(response.body, name).toEqual({
          message: 'Telegram login is invalid',
          error: 'Unauthorized',
          statusCode: 401,
        });
        expect(response.headers['set-cookie'], name).toBeUndefined();
      }
    } finally {
      await prisma.authChallenge.deleteMany({
        where: { launchId: context.launchId },
      });
    }
  });

  it('enforces the trusted pre-launch Redis limit atomically with a TTL', async () => {
    const prisma = app.get(PrismaService);
    const prelaunch = app.get(TrustedPrelaunchService);
    const redisService = app.get(RedisService);
    const environment = app.get(API_ENVIRONMENT);
    const identity = `integration-limit-${randomUUID()}`;
    const key = `auth-prelaunch:rate-limit:${identity}`;
    const redis = new Redis(environment.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    const launchIds: string[] = [];
    const challengeCountBefore = await prisma.authChallenge.count();

    try {
      await redis.connect();
      await redisService.delete(key);
      const results = await Promise.allSettled(
        Array.from(
          { length: environment.AUTH_PRELAUNCH_RATE_LIMIT_MAX + 3 },
          () => prelaunch.issue(identity),
        ),
      );
      const successes = results.filter(
        (
          result,
        ): result is PromiseFulfilledResult<{
          launchId: string;
          secret: string;
        }> => result.status === 'fulfilled',
      );
      const failures = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      launchIds.push(...successes.map((result) => result.value.launchId));

      expect(successes).toHaveLength(environment.AUTH_PRELAUNCH_RATE_LIMIT_MAX);
      expect(failures).toHaveLength(3);
      for (const failure of failures) {
        expect(failure.reason.getStatus()).toBe(429);
      }
      expect(
        await prisma.authChallenge.count({
          where: { launchId: { in: launchIds } },
        }),
      ).toBe(environment.AUTH_PRELAUNCH_RATE_LIMIT_MAX);
      expect(await prisma.authChallenge.count()).toBe(
        challengeCountBefore + environment.AUTH_PRELAUNCH_RATE_LIMIT_MAX,
      );
      expect(await redis.pttl(redisService.keyFor(key))).toBeGreaterThan(0);
    } finally {
      await prisma.authChallenge.deleteMany({
        where: { launchId: { in: launchIds } },
      });
      await redisService.delete(key);
      redis.disconnect();
    }
  });

  it('fails trusted pre-launch issuance closed when Redis is unavailable', async () => {
    const prisma = app.get(PrismaService);
    const environment = app.get(API_ENVIRONMENT);
    const before = await prisma.authChallenge.count();
    const failingRedis = {
      incrementWithExpiry: () =>
        Promise.reject(
          new Error('redis://credential-that-must-not-escape@example.test'),
        ),
    } as unknown as RedisService;
    const prelaunch = new TrustedPrelaunchService(
      prisma,
      failingRedis,
      environment,
    );

    const failure = await prelaunch
      .issue(`redis-failure-${randomUUID()}`)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect((failure as ServiceUnavailableException).getStatus()).toBe(503);
    expect((failure as Error).message).toBe('Login preparation is unavailable');
    expect((failure as Error).message).not.toContain('credential-that');
    await expect(prisma.authChallenge.count()).resolves.toBe(before);
  });

  it('bounds challenge cleanup and treats maintenance failure as non-fatal', async () => {
    const prisma = app.get(PrismaService);
    const environment = app.get(API_ENVIRONMENT);
    const redis = {
      incrementWithExpiry: () => Promise.resolve(1),
    } as unknown as RedisService;
    const prelaunch = new TrustedPrelaunchService(prisma, redis, environment);
    const suffix = randomUUID().replaceAll('-', '');
    const expiredLaunchIds = Array.from(
      { length: environment.AUTH_CHALLENGE_CLEANUP_BATCH_SIZE + 1 },
      (_, index) => `cleanup-${index}-${suffix}`,
    );
    let activeLaunchId: string | undefined;
    let failureLaunchId: string | undefined;

    try {
      await prisma.authChallenge.createMany({
        data: expiredLaunchIds.map((launchId, index) => ({
          launchId,
          tokenHash: createHmac('sha256', 'cleanup-integration')
            .update(launchId)
            .digest('hex'),
          createdAt: new Date(`2000-01-0${index + 1}T00:00:00.000Z`),
          expiresAt: new Date(`2000-01-0${index + 2}T00:00:00.000Z`),
        })),
      });

      const active = await prelaunch.issue(`cleanup-success-${suffix}`);
      activeLaunchId = active.launchId;
      expect(
        await prisma.authChallenge.count({
          where: { launchId: { in: expiredLaunchIds } },
        }),
      ).toBe(1);
      await expect(
        prisma.authChallenge.findUnique({
          where: { launchId: active.launchId },
        }),
      ).resolves.not.toBeNull();

      let transactionCall = 0;
      const failingPrisma = {
        $transaction: (
          callback: Parameters<PrismaService['$transaction']>[0],
        ) => {
          transactionCall += 1;
          if (transactionCall === 1) {
            return prisma.$transaction(callback as never);
          }
          return Promise.reject(new Error('cleanup failed'));
        },
      } as unknown as PrismaService;
      const failureTolerant = new TrustedPrelaunchService(
        failingPrisma,
        redis,
        environment,
      );
      const issued = await failureTolerant.issue(`cleanup-failure-${suffix}`);
      failureLaunchId = issued.launchId;
      await expect(
        prisma.authChallenge.findUnique({
          where: { launchId: issued.launchId },
        }),
      ).resolves.not.toBeNull();
    } finally {
      await prisma.authChallenge.deleteMany({
        where: {
          launchId: {
            in: [
              ...expiredLaunchIds,
              ...(activeLaunchId ? [activeLaunchId] : []),
              ...(failureLaunchId ? [failureLaunchId] : []),
            ],
          },
        },
      });
    }
  });

  it('rejects a challenge that expires while login waits for its row lock', async () => {
    const prisma = app.get(PrismaService);
    const prelaunch = app.get(TrustedPrelaunchService);
    const telegramUserId = `6${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const context = await prelaunch.issue(`expiry-lock-${randomUUID()}`);
    const expiresAt = new Date(Date.now() + 1_500);
    let releaseLock: (() => void) | undefined;
    let heldLock: Promise<void> | undefined;

    try {
      await prisma.authChallenge.update({
        where: { launchId: context.launchId },
        data: { expiresAt },
      });
      let signalLockAcquired: (() => void) | undefined;
      const lockAcquired = new Promise<void>((resolve) => {
        signalLockAcquired = resolve;
      });
      heldLock = prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT "id" FROM "AuthChallenge"
          WHERE "launchId" = ${context.launchId}
          FOR UPDATE
        `;
        signalLockAcquired?.();
        await new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
      });
      await lockAcquired;
      expect(Date.now()).toBeLessThan(expiresAt.getTime());

      const login = request(app.getHttpServer())
        .post('/auth/telegram')
        .set('cookie', `vpn_platform_prelaunch=${context.secret}`)
        .send({
          initData: signedTelegramInitData(telegramUserId, context.launchId),
        })
        .then((response) => response);

      let waitingForLock = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const [waiting] = await prisma.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND query LIKE '%AuthChallenge%FOR UPDATE%'
          ) AS waiting
        `;
        if (waiting?.waiting) {
          waitingForLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waitingForLock).toBe(true);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 50)),
      );
      releaseLock?.();
      const response = await login;
      await heldLock;

      expect(response.status).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
      await expect(
        prisma.userSession.count({
          where: { user: { telegramUserId } },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.authChallenge.findUniqueOrThrow({
          where: { launchId: context.launchId },
          select: { consumedAt: true, sessionId: true },
        }),
      ).resolves.toEqual({ consumedAt: null, sessionId: null });
    } finally {
      releaseLock?.();
      await heldLock?.catch(() => undefined);
      await prisma.authChallenge.deleteMany({
        where: { launchId: context.launchId },
      });
      await prisma.userSession.deleteMany({
        where: { user: { telegramUserId } },
      });
      await prisma.user.deleteMany({ where: { telegramUserId } });
    }
  });

  it('rejects retries whose bound session no longer matches the proof or secret', async () => {
    const prisma = app.get(PrismaService);
    const prelaunch = app.get(TrustedPrelaunchService);
    const telegramUserId = `5${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const context = await prelaunch.issue(`retry-binding-${randomUUID()}`);
    const initData = signedTelegramInitData(telegramUserId, context.launchId);
    let userId: string | undefined;

    try {
      const first = await request(app.getHttpServer())
        .post('/auth/telegram')
        .set('cookie', `vpn_platform_prelaunch=${context.secret}`)
        .send({ initData })
        .expect(200);
      userId = first.body.user.id;
      const challenge = await prisma.authChallenge.findUniqueOrThrow({
        where: { launchId: context.launchId },
      });
      if (!challenge.sessionId || !challenge.userId) {
        throw new Error('Consumed challenge binding is missing');
      }
      const original = await prisma.userSession.findUniqueOrThrow({
        where: { id: challenge.sessionId },
      });
      const retry = () =>
        request(app.getHttpServer())
          .post('/auth/telegram')
          .set('cookie', `vpn_platform_prelaunch=${context.secret}`)
          .send({ initData });
      const expectGenericRejection = (
        response: Awaited<ReturnType<typeof retry>>,
      ) => {
        expect(response.status).toBe(401);
        expect(response.body).toEqual({
          message: 'Telegram login is invalid',
          error: 'Unauthorized',
          statusCode: 401,
        });
        expect(response.headers['set-cookie']).toBeUndefined();
      };

      await prisma.userSession.update({
        where: { id: original.id },
        data: { telegramReplayHash: '1'.repeat(64) },
      });
      let rejected = await retry();
      expectGenericRejection(rejected);
      await prisma.userSession.update({
        where: { id: original.id },
        data: { telegramReplayHash: original.telegramReplayHash },
      });

      await prisma.userSession.update({
        where: { id: original.id },
        data: { tokenHash: '2'.repeat(64) },
      });
      rejected = await retry();
      expectGenericRejection(rejected);
      await prisma.userSession.update({
        where: { id: original.id },
        data: { tokenHash: original.tokenHash },
      });

      const otherUser = await prisma.user.create({
        data: {
          telegramUserId: `6${Date.now()}${Math.floor(Math.random() * 1_000_000)}`,
        },
      });
      try {
        await prisma.userSession.update({
          where: { id: original.id },
          data: { userId: otherUser.id },
        });
        const cascadedChallenge = await prisma.authChallenge.findUniqueOrThrow({
          where: { launchId: context.launchId },
        });
        expect(cascadedChallenge.userId).toBe(otherUser.id);

        rejected = await retry();
        expectGenericRejection(rejected);
      } finally {
        await prisma.userSession.update({
          where: { id: original.id },
          data: { userId: original.userId },
        });
        await prisma.user.delete({ where: { id: otherUser.id } });
      }

      await prisma.userSession.update({
        where: { id: original.id },
        data: { revokedAt: new Date() },
      });
      rejected = await retry();
      expectGenericRejection(rejected);
      await prisma.userSession.update({
        where: { id: original.id },
        data: { revokedAt: null },
      });

      await prisma.userSession.update({
        where: { id: original.id },
        data: { expiresAt: new Date('2001-01-01T00:00:00.000Z') },
      });
      rejected = await retry();
      expectGenericRejection(rejected);
    } finally {
      if (userId) {
        await prisma.authChallenge.deleteMany({ where: { userId } });
        await prisma.userSession.deleteMany({ where: { userId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      } else {
        await prisma.authChallenge.deleteMany({
          where: { launchId: context.launchId },
        });
      }
    }
  });

  it('enforces AuthChallenge state and composite ownership in PostgreSQL', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID().replaceAll('-', '');
    const launchIds: string[] = [];
    let firstUserId: string | undefined;
    let secondUserId: string | undefined;
    let firstSessionId: string | undefined;
    let secondSessionId: string | undefined;
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const expiresAt = new Date('2026-01-02T00:00:00.000Z');
    const consumedAt = new Date('2026-01-01T00:01:00.000Z');
    const newIdentity = (label: string) => {
      const launchId = `${label}-${suffix}`;
      launchIds.push(launchId);
      return {
        launchId,
        tokenHash: createHmac('sha256', 'constraint-integration')
          .update(launchId)
          .digest('hex'),
      };
    };

    try {
      const [firstUser, secondUser] = await prisma.$transaction([
        prisma.user.create({
          data: { telegramUserId: `31${suffix.slice(0, 20)}` },
        }),
        prisma.user.create({
          data: { telegramUserId: `32${suffix.slice(0, 20)}` },
        }),
      ]);
      firstUserId = firstUser.id;
      secondUserId = secondUser.id;
      const [firstSession, secondSession] = await prisma.$transaction([
        prisma.userSession.create({
          data: {
            userId: firstUser.id,
            tokenHash: createHmac('sha256', 'constraint-session')
              .update(`first-${suffix}`)
              .digest('hex'),
            telegramReplayHash: createHmac('sha256', 'constraint-replay')
              .update(`first-${suffix}`)
              .digest('hex'),
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          },
        }),
        prisma.userSession.create({
          data: {
            userId: secondUser.id,
            tokenHash: createHmac('sha256', 'constraint-session')
              .update(`second-${suffix}`)
              .digest('hex'),
            telegramReplayHash: createHmac('sha256', 'constraint-replay')
              .update(`second-${suffix}`)
              .digest('hex'),
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          },
        }),
      ]);
      firstSessionId = firstSession.id;
      secondSessionId = secondSession.id;

      const invalidWrites = [
        prisma.authChallenge.create({
          data: {
            ...newIdentity('consumed-only'),
            createdAt,
            expiresAt,
            consumedAt,
          },
        }),
        prisma.authChallenge.create({
          data: {
            ...newIdentity('replay-only'),
            createdAt,
            expiresAt,
            telegramReplayHash: '3'.repeat(64),
          },
        }),
        prisma.authChallenge.create({
          data: {
            ...newIdentity('binding-without-consumed'),
            createdAt,
            expiresAt,
            telegramReplayHash: '4'.repeat(64),
            sessionId: firstSession.id,
            userId: firstUser.id,
          },
        }),
        prisma.authChallenge.create({
          data: {
            ...newIdentity('partial-consumed'),
            createdAt,
            expiresAt,
            consumedAt,
            telegramReplayHash: '5'.repeat(64),
            userId: firstUser.id,
          },
        }),
        prisma.authChallenge.create({
          data: {
            ...newIdentity('invalid-expiry'),
            createdAt,
            expiresAt: createdAt,
          },
        }),
        prisma.authChallenge.create({
          data: {
            ...newIdentity('consumed-before-created'),
            createdAt,
            expiresAt,
            consumedAt: new Date('2025-12-31T23:59:59.000Z'),
            telegramReplayHash: '6'.repeat(64),
            sessionId: firstSession.id,
            userId: firstUser.id,
          },
        }),
        prisma.authChallenge.create({
          data: {
            ...newIdentity('cross-user-session'),
            createdAt,
            expiresAt,
            consumedAt,
            telegramReplayHash: '7'.repeat(64),
            sessionId: firstSession.id,
            userId: secondUser.id,
          },
        }),
      ];
      for (const write of invalidWrites) {
        await expect(write).rejects.toBeDefined();
      }
      await expect(
        prisma.authChallenge.count({
          where: { launchId: { in: launchIds } },
        }),
      ).resolves.toBe(0);

      const validIdentity = newIdentity('restrict-session-delete');
      await prisma.authChallenge.create({
        data: {
          ...validIdentity,
          createdAt,
          expiresAt,
          consumedAt,
          telegramReplayHash: firstSession.telegramReplayHash,
          sessionId: firstSession.id,
          userId: firstUser.id,
        },
      });
      await expect(
        prisma.userSession.delete({ where: { id: firstSession.id } }),
      ).rejects.toBeDefined();
      await expect(
        prisma.authChallenge.findUnique({
          where: { launchId: validIdentity.launchId },
        }),
      ).resolves.not.toBeNull();
    } finally {
      await prisma.authChallenge.deleteMany({
        where: { launchId: { in: launchIds } },
      });
      if (firstSessionId || secondSessionId) {
        await prisma.userSession.deleteMany({
          where: {
            id: {
              in: [firstSessionId, secondSessionId].filter(
                (id): id is string => id !== undefined,
              ),
            },
          },
        });
      }
      if (firstUserId || secondUserId) {
        await prisma.user.deleteMany({
          where: {
            id: {
              in: [firstUserId, secondUserId].filter(
                (id): id is string => id !== undefined,
              ),
            },
          },
        });
      }
    }
  });
});
