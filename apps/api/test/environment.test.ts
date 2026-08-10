import { describe, expect, it } from 'vitest';

import { parseApiEnvironment } from '../src/config/environment';

describe('API environment', () => {
  it('parses valid PostgreSQL and Redis connection URLs', () => {
    const environment = parseApiEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test?schema=public',
      REDIS_URL: 'redis://127.0.0.1:6379',
      HEALTH_CHECK_TIMEOUT_MS: '500',
    });

    expect(environment).toMatchObject({
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: 3001,
      HEALTH_CHECK_TIMEOUT_MS: 500,
      ORCHESTRATION_LEASE_DURATION_MS: 30_000,
      ORCHESTRATION_MAX_ATTEMPTS: 5,
    });
  });

  it('rejects a connection URL with the wrong protocol', () => {
    expect(() =>
      parseApiEnvironment({
        DATABASE_URL: 'https://database.example.test',
        REDIS_URL: 'redis://127.0.0.1:6379',
      }),
    ).toThrow();
  });

  it('parses the local subscription prototype flag strictly', () => {
    const baseEnvironment = {
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test?schema=public',
      REDIS_URL: 'redis://127.0.0.1:6379',
    };

    expect(
      parseApiEnvironment(baseEnvironment).LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED,
    ).toBe(false);

    expect(
      parseApiEnvironment({
        ...baseEnvironment,
        LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED: 'false',
      }).LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED,
    ).toBe(false);
    expect(
      parseApiEnvironment({
        ...baseEnvironment,
        LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED: 'true',
        LOCAL_SUBSCRIPTION_PROTOTYPE_TOKEN:
          'prototype-token-for-local-tests-12345',
      }).LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED,
    ).toBe(true);

    expect(() =>
      parseApiEnvironment({
        ...baseEnvironment,
        LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED: 'true',
      }),
    ).toThrow(/LOCAL_SUBSCRIPTION_PROTOTYPE_TOKEN/);
  });

  it('rejects the local subscription prototype in production', () => {
    expect(() =>
      parseApiEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL:
          'postgresql://test:test@127.0.0.1:5432/test?schema=public',
        REDIS_URL: 'redis://127.0.0.1:6379',
        LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED: 'true',
        LOCAL_SUBSCRIPTION_PROTOTYPE_TOKEN:
          'prototype-token-for-local-tests-12345',
      }),
    ).toThrow(/LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED/);
  });

  it('rejects an invalid orchestration policy', () => {
    const baseEnvironment = {
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test?schema=public',
      REDIS_URL: 'redis://127.0.0.1:6379',
    };

    expect(() =>
      parseApiEnvironment({
        ...baseEnvironment,
        ORCHESTRATION_MAX_ATTEMPTS: '0',
      }),
    ).toThrow(/ORCHESTRATION_MAX_ATTEMPTS/);
  });
});
