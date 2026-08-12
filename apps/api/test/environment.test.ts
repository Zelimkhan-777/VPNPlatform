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

  it('requires a node-agent credential pepper in production', () => {
    const baseEnvironment = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test?schema=public',
      REDIS_URL: 'redis://127.0.0.1:6379',
    };

    expect(() => parseApiEnvironment(baseEnvironment)).toThrow(
      /NODE_AGENT_CREDENTIAL_PEPPER/,
    );
    expect(
      parseApiEnvironment({
        ...baseEnvironment,
        NODE_AGENT_CREDENTIAL_PEPPER:
          'node-agent-credential-pepper-for-production-tests',
        TELEGRAM_WEB_APP_BOT_TOKEN: '123456:telegram-production-test-token',
        AUTH_SESSION_PEPPER: 'auth-session-pepper-for-production-tests',
        SUBSCRIPTION_TOKEN_PEPPER:
          'subscription-token-pepper-for-production-tests',
        SUBSCRIPTION_FEED_BASE_URL: 'https://sub.example.test',
        CABINET_ORIGIN: 'https://app.example.test',
      }).NODE_AGENT_CREDENTIAL_PEPPER,
    ).toBe('node-agent-credential-pepper-for-production-tests');
  });

  it('requires Telegram login secrets in production', () => {
    const baseEnvironment = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test?schema=public',
      REDIS_URL: 'redis://127.0.0.1:6379',
      NODE_AGENT_CREDENTIAL_PEPPER:
        'node-agent-credential-pepper-for-production-tests',
      SUBSCRIPTION_TOKEN_PEPPER:
        'subscription-token-pepper-for-production-tests',
      SUBSCRIPTION_FEED_BASE_URL: 'https://sub.example.test',
      CABINET_ORIGIN: 'https://app.example.test',
    };

    expect(() => parseApiEnvironment(baseEnvironment)).toThrow(
      /TELEGRAM_WEB_APP_BOT_TOKEN/,
    );
    expect(() =>
      parseApiEnvironment({
        ...baseEnvironment,
        TELEGRAM_WEB_APP_BOT_TOKEN: '123456:telegram-production-test-token',
      }),
    ).toThrow(/AUTH_SESSION_PEPPER/);
    expect(
      parseApiEnvironment({
        ...baseEnvironment,
        TELEGRAM_WEB_APP_BOT_TOKEN: '123456:telegram-production-test-token',
        AUTH_SESSION_PEPPER: 'auth-session-pepper-for-production-tests',
      }).AUTH_SESSION_TTL_SECONDS,
    ).toBe(604_800);
  });

  it('requires a subscription token pepper in production', () => {
    expect(() =>
      parseApiEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL:
          'postgresql://test:test@127.0.0.1:5432/test?schema=public',
        REDIS_URL: 'redis://127.0.0.1:6379',
        NODE_AGENT_CREDENTIAL_PEPPER:
          'node-agent-credential-pepper-for-production-tests',
        TELEGRAM_WEB_APP_BOT_TOKEN: '123456:telegram-production-test-token',
        AUTH_SESSION_PEPPER: 'auth-session-pepper-for-production-tests',
      }),
    ).toThrow(/SUBSCRIPTION_TOKEN_PEPPER/);
  });

  it('requires subscription and cabinet origins in production', () => {
    const baseEnvironment = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test?schema=public',
      REDIS_URL: 'redis://127.0.0.1:6379',
      NODE_AGENT_CREDENTIAL_PEPPER:
        'node-agent-credential-pepper-for-production-tests',
      TELEGRAM_WEB_APP_BOT_TOKEN: '123456:telegram-production-test-token',
      AUTH_SESSION_PEPPER: 'auth-session-pepper-for-production-tests',
      SUBSCRIPTION_TOKEN_PEPPER:
        'subscription-token-pepper-for-production-tests',
    };

    expect(() => parseApiEnvironment(baseEnvironment)).toThrow(
      /SUBSCRIPTION_FEED_BASE_URL/,
    );
    expect(() =>
      parseApiEnvironment({
        ...baseEnvironment,
        SUBSCRIPTION_FEED_BASE_URL: 'https://sub.example.test',
      }),
    ).toThrow(/CABINET_ORIGIN/);
  });

  it('accepts local-only subscription fixture content', () => {
    const environment = parseApiEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test?schema=public',
      REDIS_URL: 'redis://127.0.0.1:6379',
      LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED: 'true',
      LOCAL_SUBSCRIPTION_PROTOTYPE_TOKEN:
        'prototype-token-for-local-tests-12345',
      LOCAL_SUBSCRIPTION_PROTOTYPE_CONTENT: 'local fixture',
    });

    expect(environment.LOCAL_SUBSCRIPTION_PROTOTYPE_CONTENT).toBe(
      'local fixture',
    );
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
