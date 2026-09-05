import { createHmac } from 'node:crypto';

import type { ApiEnvironment } from '../config/environment';
import type { PrismaService } from '../database/prisma.service';
import { AuthSessionService } from './auth-session.service';
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

describe('AuthSessionService', () => {
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
