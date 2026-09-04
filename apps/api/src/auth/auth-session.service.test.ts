import { createHmac } from 'node:crypto';

import type { ApiEnvironment } from '../config/environment';
import type { PrismaService } from '../database/prisma.service';
import {
  AuthSessionService,
  TelegramInitDataValidationError,
} from './auth-session.service';
import { describe, expect, it, vi } from 'vitest';

const botToken = '123456:telegram-auth-test-token';
const sessionPepper = 'session-pepper-for-authentication-unit-tests';
const now = new Date('2026-08-11T12:00:00.000Z');

function environment(overrides: Partial<ApiEnvironment> = {}): ApiEnvironment {
  return {
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: 3001,
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test?schema=public',
    REDIS_URL: 'redis://127.0.0.1:6379',
    API_REDIS_KEY_NAMESPACE: 'vpn-platform:api',
    HEALTH_CHECK_TIMEOUT_MS: 750,
    LOG_LEVEL: 'silent',
    TRUSTED_PROXY_IPS: [],
    TELEGRAM_WEB_APP_BOT_TOKEN: botToken,
    AUTH_SESSION_PEPPER: sessionPepper,
    SUBSCRIPTION_TOKEN_PEPPER: undefined,
    SUBSCRIPTION_FEED_RATE_LIMIT_MAX: 60,
    SUBSCRIPTION_FEED_RATE_LIMIT_WINDOW_MS: 60_000,
    SUBSCRIPTION_FEED_RENDERING_ENABLED: false,
    SUBSCRIPTION_FEED_MAX_ROUTES: 25,
    AUTH_SESSION_TTL_SECONDS: 3_600,
    TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: 300,
    AUTH_PRELAUNCH_RATE_LIMIT_MAX: 10,
    AUTH_PRELAUNCH_RATE_LIMIT_WINDOW_MS: 60_000,
    AUTH_CHALLENGE_CLEANUP_BATCH_SIZE: 100,
    TRIAL_ACTIVATION_RATE_LIMIT_MAX: 5,
    TRIAL_ACTIVATION_RATE_LIMIT_WINDOW_MS: 60_000,
    NODE_AGENT_CREDENTIAL_PEPPER: undefined,
    LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED: false,
    LOCAL_SUBSCRIPTION_PROTOTYPE_TOKEN: undefined,
    LOCAL_SUBSCRIPTION_PROTOTYPE_CONTENT: undefined,
    LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_MAX: 5,
    LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_WINDOW_MS: 60_000,
    LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_MAX_CLIENTS: 10_000,
    ...overrides,
  };
}

function signedInitData(telegramUserId = '123456789'): string {
  const parameters = new URLSearchParams({
    auth_date: String(Math.floor(now.getTime() / 1_000)),
    query_id: 'AAEAAQ',
    user: JSON.stringify({ id: telegramUserId }),
    start_param: 'a'.repeat(43),
  });
  const dataCheckString = [...parameters.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  parameters.set(
    'hash',
    createHmac('sha256', secretKey).update(dataCheckString).digest('hex'),
  );
  return parameters.toString();
}

describe('AuthSessionService', () => {
  it('verifies Telegram initData and persists only an opaque session hash', async () => {
    const userUpsert = vi.fn().mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      role: 'CUSTOMER',
    });
    const userSessionCreate = vi.fn().mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      expiresAt: new Date('2026-08-11T13:00:00.000Z'),
    });
    const prisma = {
      $transaction: (callback: (transaction: unknown) => unknown) =>
        callback({
          $queryRaw: vi
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ now }]),
          user: { upsert: userUpsert },
          authChallenge: {
            findUnique: vi.fn().mockResolvedValue({
              id: 'challenge',
              launchId: 'a'.repeat(43),
              expiresAt: new Date('2026-08-11T12:05:00.000Z'),
              telegramReplayHash: null,
              sessionId: null,
              userId: null,
            }),
            update: vi.fn(),
          },
          userSession: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: userSessionCreate,
          },
        }),
    } as unknown as PrismaService;
    const service = new AuthSessionService(prisma, environment());

    const issued = await service.signInWithTelegram(
      signedInitData(),
      'a'.repeat(43),
      now,
    );

    expect(issued?.session).toEqual({
      user: { id: '11111111-1111-4111-8111-111111111111', role: 'CUSTOMER' },
      expiresAt: '2026-08-11T13:00:00.000Z',
    });
    expect(issued?.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(userUpsert).toHaveBeenCalledWith({
      where: { telegramUserId: '123456789' },
      create: { telegramUserId: '123456789' },
      update: {},
      select: { id: true, role: true },
    });
    expect(userSessionCreate.mock.calls[0]?.[0].data).toMatchObject({
      userId: '11111111-1111-4111-8111-111111111111',
      expiresAt: new Date('2026-08-11T13:00:00.000Z'),
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(userSessionCreate.mock.calls[0]?.[0].data.tokenHash).not.toBe(
      issued?.secret,
    );
  });

  it('allows retry only through the same consumed challenge', async () => {
    const userSessionCreate = vi.fn().mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      expiresAt: new Date('2026-08-11T13:00:00.000Z'),
    });
    const userSessionFindUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        expiresAt: new Date('2026-08-11T13:00:00.000Z'),
        user: { id: '11111111-1111-4111-8111-111111111111', role: 'CUSTOMER' },
      });
    const challengeFindUnique = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'challenge',
        launchId: 'a'.repeat(43),
        expiresAt: new Date('2026-08-11T12:05:00.000Z'),
        telegramReplayHash: null,
        sessionId: null,
        userId: null,
      })
      .mockResolvedValueOnce({
        id: 'challenge',
        launchId: 'a'.repeat(43),
        expiresAt: new Date('2026-08-11T12:05:00.000Z'),
        telegramReplayHash: null,
        sessionId: '22222222-2222-4222-8222-222222222222',
        userId: '11111111-1111-4111-8111-111111111111',
      });
    const service = new AuthSessionService(
      {
        $transaction: (callback: (transaction: unknown) => unknown) =>
          callback({
            $queryRaw: vi
              .fn()
              .mockResolvedValueOnce([])
              .mockResolvedValueOnce([{ now }])
              .mockResolvedValueOnce([])
              .mockResolvedValueOnce([{ now }]),
            user: {
              upsert: vi.fn().mockResolvedValue({
                id: '11111111-1111-4111-8111-111111111111',
                role: 'CUSTOMER',
              }),
            },
            authChallenge: { findUnique: challengeFindUnique, update: vi.fn() },
            userSession: {
              findFirst: userSessionFindUnique,
              findUnique: userSessionFindUnique,
              create: userSessionCreate,
            },
          }),
      } as unknown as PrismaService,
      environment(),
    );

    const first = await service.signInWithTelegram(
      signedInitData(),
      'a'.repeat(43),
      now,
    );
    const replay = await service.signInWithTelegram(
      signedInitData(),
      'a'.repeat(43),
      now,
    );

    expect(replay?.secret).toBe(first?.secret);
    expect(userSessionCreate).toHaveBeenCalledTimes(1);
    expect(userSessionFindUnique).toHaveBeenLastCalledWith({
      where: {
        id: '22222222-2222-4222-8222-222222222222',
        userId: '11111111-1111-4111-8111-111111111111',
        telegramReplayHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        revokedAt: null,
        expiresAt: { gt: now },
        user: { telegramUserId: '123456789' },
      },
      select: {
        expiresAt: true,
        user: { select: { id: true, role: true } },
      },
    });
  });

  it('rejects forged Telegram initData before accessing the database', async () => {
    const transaction = vi.fn();
    const service = new AuthSessionService(
      { $transaction: transaction } as unknown as PrismaService,
      environment(),
    );

    await expect(
      service.signInWithTelegram(`${signedInitData()}tampered`, now),
    ).rejects.toBeInstanceOf(TelegramInitDataValidationError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rechecks Telegram proof freshness after acquiring the database lock', async () => {
    const userSessionCreate = vi.fn();
    const authoritativeNow = new Date(now.getTime() + 301_000);
    const service = new AuthSessionService(
      {
        $transaction: (callback: (transaction: unknown) => unknown) =>
          callback({
            $queryRaw: vi
              .fn()
              .mockResolvedValueOnce([])
              .mockResolvedValueOnce([{ now: authoritativeNow }]),
            authChallenge: {
              findUnique: vi.fn().mockResolvedValue({
                id: 'challenge',
                launchId: 'a'.repeat(43),
                expiresAt: new Date(authoritativeNow.getTime() + 60_000),
                telegramReplayHash: null,
                sessionId: null,
                userId: null,
              }),
            },
            userSession: { create: userSessionCreate },
          }),
      } as unknown as PrismaService,
      environment(),
    );

    await expect(
      service.signInWithTelegram(signedInitData(), 'a'.repeat(43), now),
    ).rejects.toBeInstanceOf(TelegramInitDataValidationError);
    expect(userSessionCreate).not.toHaveBeenCalled();
  });

  it('does not expose an authentication path until its server secrets are configured', async () => {
    const transaction = vi.fn();
    const service = new AuthSessionService(
      { $transaction: transaction } as unknown as PrismaService,
      environment({ AUTH_SESSION_PEPPER: undefined }),
    );

    await expect(
      service.signInWithTelegram(signedInitData(), now),
    ).resolves.toBe(null);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('looks up an unexpired session by a keyed hash', async () => {
    const secret = 'a'.repeat(43);
    const findFirst = vi.fn().mockResolvedValue({
      expiresAt: new Date('2026-08-11T13:00:00.000Z'),
      user: { id: '11111111-1111-4111-8111-111111111111', role: 'CUSTOMER' },
    });
    const service = new AuthSessionService(
      { userSession: { findFirst } } as unknown as PrismaService,
      environment(),
    );

    await expect(service.currentSession(secret, now)).resolves.toEqual({
      user: { id: '11111111-1111-4111-8111-111111111111', role: 'CUSTOMER' },
      expiresAt: '2026-08-11T13:00:00.000Z',
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        tokenHash: createHmac('sha256', sessionPepper)
          .update(secret)
          .digest('hex'),
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: {
        expiresAt: true,
        user: { select: { id: true, role: true } },
      },
    });
  });
});
