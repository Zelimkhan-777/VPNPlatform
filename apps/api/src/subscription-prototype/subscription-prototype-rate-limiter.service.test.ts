import { describe, expect, it, vi } from 'vitest';

import {
  parseApiEnvironment,
  type ApiEnvironment,
} from '../config/environment';
import { SubscriptionPrototypeRateLimiterService } from './subscription-prototype-rate-limiter.service';

function environment(
  overrides: Partial<NodeJS.ProcessEnv> = {},
): ApiEnvironment {
  return parseApiEnvironment({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test?schema=public',
    REDIS_URL: 'redis://127.0.0.1:6379',
    LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED: 'true',
    LOCAL_SUBSCRIPTION_PROTOTYPE_TOKEN: 'prototype-token-for-local-tests-12345',
    LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_MAX: '1',
    LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_WINDOW_MS: '1000',
    LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_MAX_CLIENTS: '1',
    ...overrides,
  });
}

describe('SubscriptionPrototypeRateLimiterService', () => {
  it('does not track clients while the local prototype is disabled', () => {
    const limiter = new SubscriptionPrototypeRateLimiterService(
      environment({ LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED: 'false' }),
    );

    expect(() => limiter.assertAllowed('192.0.2.1')).not.toThrow();
    expect(() => limiter.assertAllowed('192.0.2.2')).not.toThrow();
  });

  it('bounds clients and reclaims expired windows', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
      const limiter = new SubscriptionPrototypeRateLimiterService(
        environment(),
      );

      limiter.assertAllowed('192.0.2.1');
      expect(() => limiter.assertAllowed('192.0.2.2')).toThrow(
        'Too many requests',
      );

      vi.advanceTimersByTime(1_000);
      expect(() => limiter.assertAllowed('192.0.2.2')).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
