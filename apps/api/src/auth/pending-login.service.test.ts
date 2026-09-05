import { createHmac } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { ApiEnvironment } from '../config/environment';
import type { PrismaService } from '../database/prisma.service';
import type { AuthIssuerRateLimiterService } from './auth-issuer-rate-limiter.service';
import type { AuthenticatedBotRequest } from './bot-request-authentication.service';
import type { BotRequestExecutionService } from './bot-request-execution.service';
import { PendingLoginService } from './pending-login.service';
import { TelegramInitDataValidationError } from './telegram-init-data';

const botToken = '123456:pending-login-test-token';
const pepper = 'pending-login-pepper-for-unit-tests';
const now = new Date('2026-09-05T12:00:00.000Z');
const userId = '11111111-1111-4111-8111-111111111111';
const telegramUserId = '123456789';
const launchId = 'a'.repeat(43);
const challengeId = '22222222-2222-4222-8222-222222222222';
const pendingId = '33333333-3333-4333-8333-333333333333';
const authenticatedBot: AuthenticatedBotRequest = {
  credentialId: '44444444-4444-4444-8444-444444444444',
  idempotencyKey: 'confirm-1',
  method: 'POST',
  path: '/auth/telegram/confirm',
  principalId: '55555555-5555-4555-8555-555555555555',
  requestHash: 'a'.repeat(64),
  telegramUserId,
};

function signedInitData(): string {
  const parameters = new URLSearchParams({
    auth_date: String(Math.floor(now.getTime() / 1_000)),
    query_id: 'AAEAAQ',
    user: JSON.stringify({ id: telegramUserId }),
    start_param: launchId,
  });
  const check = [...parameters.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const key = createHmac('sha256', 'WebAppData').update(botToken).digest();
  parameters.set('hash', createHmac('sha256', key).update(check).digest('hex'));
  return parameters.toString();
}

function environment(): ApiEnvironment {
  return {
    TELEGRAM_WEB_APP_BOT_TOKEN: botToken,
    AUTH_SESSION_PEPPER: pepper,
    AUTH_SESSION_TTL_SECONDS: 3_600,
    TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: 300,
  } as ApiEnvironment;
}

function harness(
  challengeExpiresAt: Date,
  challengeTelegramId = telegramUserId,
) {
  const create = vi.fn().mockResolvedValue(undefined);
  const transaction = {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ now }]),
    authChallenge: {
      findUnique: vi.fn().mockResolvedValue({
        id: challengeId,
        userId,
        expiresAt: challengeExpiresAt,
        consumedAt: null,
        user: { telegramUserId: challengeTelegramId },
      }),
    },
    pendingLogin: { create },
  };
  const transactionRunner = vi.fn(
    (operation: (client: typeof transaction) => Promise<unknown>) =>
      operation(transaction),
  );
  const prisma = {
    $transaction: transactionRunner,
  } as unknown as PrismaService;
  const assertInitialAllowed = vi.fn().mockResolvedValue(undefined);
  const service = new PendingLoginService(
    prisma,
    environment(),
    {
      assertInitialAllowed,
    } as unknown as AuthIssuerRateLimiterService,
    {} as never,
  );
  return {
    assertInitialAllowed,
    create,
    service,
    transaction,
    transactionRunner,
  };
}

describe('PendingLoginService', () => {
  it('creates a client-bound pending login with the earlier challenge expiry', async () => {
    const { assertInitialAllowed, create, service } = harness(
      new Date('2026-09-05T12:01:00.000Z'),
    );

    const result = await service.begin(signedInitData(), now);

    expect(assertInitialAllowed).toHaveBeenCalledWith(telegramUserId);
    expect(result.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.pending).toEqual({
      confirmationCode: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{8}$/),
      expiresAt: '2026-09-05T12:01:00.000Z',
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        challengeId,
        userId,
        telegramUserId,
        pendingTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        confirmationCodeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        createdAt: now,
        expiresAt: new Date('2026-09-05T12:01:00.000Z'),
      },
    });
    expect(JSON.stringify(result.pending)).not.toContain(result.secret);
  });

  it('caps pending lifetime at 120 seconds', async () => {
    const { service } = harness(new Date('2026-09-05T12:05:00.000Z'));
    await expect(service.begin(signedInitData(), now)).resolves.toMatchObject({
      pending: { expiresAt: '2026-09-05T12:02:00.000Z' },
    });
  });

  it('fails closed when the challenge owner differs from Telegram proof', async () => {
    const { create, service } = harness(
      new Date('2026-09-05T12:02:00.000Z'),
      '987654321',
    );
    await expect(service.begin(signedInitData(), now)).rejects.toBeInstanceOf(
      TelegramInitDataValidationError,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('regenerates pending material after a unique confirmation collision', async () => {
    const { service, transaction, transactionRunner } = harness(
      new Date('2026-09-05T12:02:00.000Z'),
    );
    const uniqueCollision = new Prisma.PrismaClientKnownRequestError(
      'Pending confirmation code collides',
      {
        code: 'P2002',
        clientVersion: '6.19.3',
        meta: { target: 'PendingLogin_confirmation_scope_key' },
      },
    );
    transactionRunner
      .mockRejectedValueOnce(uniqueCollision)
      .mockImplementationOnce(
        (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction) as never,
      );

    await expect(service.begin(signedInitData(), now)).resolves.toMatchObject({
      pending: {
        confirmationCode: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{8}$/),
      },
    });
    expect(transactionRunner).toHaveBeenCalledTimes(2);
  });

  it('confirms exactly one unexpired pending login under bot idempotency', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: pendingId }])
        .mockResolvedValueOnce([{ now }]),
      pendingLogin: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: pendingId,
            challengeId,
            userId,
            telegramUserId,
            expiresAt: new Date('2026-09-05T12:01:00.000Z'),
            status: 'AWAITING_BOT_CONFIRM',
            challenge: {
              consumedAt: null,
              expiresAt: new Date('2026-09-05T12:01:00.000Z'),
            },
          },
        ]),
        update,
      },
    };
    const execute = vi.fn(
      async (
        _request: AuthenticatedBotRequest,
        operation: (client: typeof transaction) => Promise<{
          statusCode: number;
          body: { status: 'BOT_CONFIRMED' };
        }>,
      ) => ({ ...(await operation(transaction)), replayed: false }),
    );
    const assertConfirmationAllowed = vi.fn().mockResolvedValue(undefined);
    const service = new PendingLoginService(
      {} as never,
      environment(),
      { assertConfirmationAllowed } as unknown as AuthIssuerRateLimiterService,
      { execute } as unknown as BotRequestExecutionService,
    );

    await expect(
      service.confirm(authenticatedBot, '01AB2CD3'),
    ).resolves.toEqual({ status: 'BOT_CONFIRMED' });
    expect(assertConfirmationAllowed).toHaveBeenCalledWith(
      authenticatedBot.principalId,
      telegramUserId,
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: pendingId },
      data: { status: 'BOT_CONFIRMED', confirmedAt: now },
    });
  });

  it('does not confirm when the challenge has expired after pending creation', async () => {
    const update = vi.fn();
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: pendingId }])
        .mockResolvedValueOnce([{ now }]),
      pendingLogin: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: pendingId,
            challengeId,
            userId,
            telegramUserId,
            expiresAt: new Date('2026-09-05T12:01:00.000Z'),
            status: 'AWAITING_BOT_CONFIRM',
            challenge: {
              consumedAt: null,
              expiresAt: now,
            },
          },
        ]),
        update,
      },
    };
    const execute = vi.fn(
      async (
        _request: AuthenticatedBotRequest,
        operation: (client: typeof transaction) => Promise<unknown>,
      ) => operation(transaction),
    );
    const service = new PendingLoginService(
      {} as never,
      environment(),
      { assertConfirmationAllowed: vi.fn() } as never,
      { execute } as unknown as BotRequestExecutionService,
    );

    await expect(
      service.confirm(authenticatedBot, '01AB2CD3'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(update).not.toHaveBeenCalled();
  });

  it('returns an exact idempotency replay without spending confirm rate limit', async () => {
    const assertConfirmationAllowed = vi.fn();
    const execute = vi.fn().mockResolvedValue({
      statusCode: 200,
      body: { status: 'BOT_CONFIRMED' },
      replayed: true,
    });
    const service = new PendingLoginService(
      {} as never,
      environment(),
      { assertConfirmationAllowed } as unknown as AuthIssuerRateLimiterService,
      { execute } as unknown as BotRequestExecutionService,
    );

    await expect(
      service.confirm(authenticatedBot, '01AB2CD3'),
    ).resolves.toEqual({ status: 'BOT_CONFIRMED' });
    expect(assertConfirmationAllowed).not.toHaveBeenCalled();
  });

  it('does not inspect or mutate pending state when confirm rate limiting fails', async () => {
    const queryRaw = vi.fn();
    const update = vi.fn();
    const failure = new Error('redis unavailable');
    const transaction = {
      $queryRaw: queryRaw,
      pendingLogin: { findMany: vi.fn(), update },
    };
    const execute = vi.fn(
      async (
        _request: AuthenticatedBotRequest,
        operation: (client: typeof transaction) => Promise<unknown>,
      ) => operation(transaction),
    );
    const service = new PendingLoginService(
      {} as never,
      environment(),
      {
        assertConfirmationAllowed: vi.fn().mockRejectedValue(failure),
      } as unknown as AuthIssuerRateLimiterService,
      { execute } as unknown as BotRequestExecutionService,
    );

    await expect(service.confirm(authenticatedBot, '01AB2CD3')).rejects.toBe(
      failure,
    );
    expect(queryRaw).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('atomically consumes confirmed pending login and creates one session', async () => {
    const pendingUpdate = vi.fn().mockResolvedValue(undefined);
    const challengeUpdate = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({
      id: '66666666-6666-4666-8666-666666666666',
    });
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: pendingId }])
        .mockResolvedValueOnce([{ now }]),
      pendingLogin: {
        findUnique: vi.fn().mockResolvedValue({
          id: pendingId,
          challengeId,
          userId,
          telegramUserId,
          expiresAt: new Date('2026-09-05T12:01:00.000Z'),
          status: 'BOT_CONFIRMED',
          challenge: {
            consumedAt: null,
            expiresAt: new Date('2026-09-05T12:01:00.000Z'),
          },
        }),
        update: pendingUpdate,
      },
      user: {
        findFirst: vi.fn().mockResolvedValue({ id: userId, role: 'CUSTOMER' }),
      },
      userSession: { create: sessionCreate },
      authChallenge: { update: challengeUpdate },
    };
    const prisma = {
      $transaction: vi.fn(
        (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    } as unknown as PrismaService;
    const service = new PendingLoginService(
      prisma,
      environment(),
      {} as never,
      {} as never,
    );

    const result = await service.complete('p'.repeat(43));
    expect(result.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.session).toEqual({
      user: { id: userId, role: 'CUSTOMER' },
      expiresAt: '2026-09-05T13:00:00.000Z',
    });
    expect(sessionCreate).toHaveBeenCalledWith({
      data: {
        userId,
        tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        telegramReplayHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        expiresAt: new Date('2026-09-05T13:00:00.000Z'),
      },
      select: { id: true },
    });
    expect(pendingUpdate).toHaveBeenCalledWith({
      where: { id: pendingId },
      data: { status: 'CONSUMED', consumedAt: now },
    });
    expect(challengeUpdate).toHaveBeenCalledWith({
      where: { id: challengeId },
      data: {
        telegramReplayHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        sessionId: '66666666-6666-4666-8666-666666666666',
        consumedAt: now,
      },
    });
  });

  it('does not create a session before bot confirmation', async () => {
    const sessionCreate = vi.fn();
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: pendingId }])
        .mockResolvedValueOnce([{ now }]),
      pendingLogin: {
        findUnique: vi.fn().mockResolvedValue({
          id: pendingId,
          challengeId,
          userId,
          telegramUserId,
          expiresAt: new Date('2026-09-05T12:01:00.000Z'),
          status: 'AWAITING_BOT_CONFIRM',
          challenge: {
            consumedAt: null,
            expiresAt: new Date('2026-09-05T12:01:00.000Z'),
          },
        }),
      },
      userSession: { create: sessionCreate },
    };
    const prisma = {
      $transaction: vi.fn(
        (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    } as unknown as PrismaService;
    const service = new PendingLoginService(
      prisma,
      environment(),
      {} as never,
      {} as never,
    );

    await expect(service.complete('p'.repeat(43))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessionCreate).not.toHaveBeenCalled();
  });
});
