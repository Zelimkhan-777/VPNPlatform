import { describe, expect, it } from 'vitest';

import { parseBotEnvironment } from './environment';

describe('bot environment', () => {
  it('keeps the inactive image smoke path secret-free', () => {
    expect(parseBotEnvironment({})).toMatchObject({
      BOT_SIGNING_ENABLED: false,
      BOT_TELEGRAM_MODE: 'inactive',
      LOG_LEVEL: 'info',
    });
  });

  it('requires signing and a private token file for polling', () => {
    expect(() => parseBotEnvironment({ BOT_TELEGRAM_MODE: 'polling' })).toThrow(
      /BOT_SIGNING_ENABLED/,
    );
    expect(() =>
      parseBotEnvironment({
        BOT_TELEGRAM_MODE: 'polling',
        BOT_SIGNING_ENABLED: 'true',
        BOT_API_BASE_URL: 'http://api:3001',
        BOT_CREDENTIAL_FILE: '/run/secrets/bot_credential',
        BOT_CREDENTIAL_GID: '29002',
      }),
    ).toThrow(/TELEGRAM_BOT_TOKEN_FILE/);
    expect(
      parseBotEnvironment({
        BOT_TELEGRAM_MODE: 'polling',
        BOT_SIGNING_ENABLED: 'true',
        BOT_API_BASE_URL: 'http://api:3001',
        BOT_CREDENTIAL_FILE: '/run/secrets/bot_credential',
        BOT_CREDENTIAL_GID: '29002',
        TELEGRAM_BOT_TOKEN_FILE: '/run/secrets/telegram_token',
        TELEGRAM_MINI_APP_BASE_URL: 'https://t.me/meteora_test_bot/cabinet',
      }),
    ).toMatchObject({
      BOT_TELEGRAM_MODE: 'polling',
      TELEGRAM_BOT_TOKEN_FILE: '/run/secrets/telegram_token',
      TELEGRAM_MINI_APP_BASE_URL: 'https://t.me/meteora_test_bot/cabinet',
    });
  });

  it('requires an exact direct Mini App link in polling mode', () => {
    const base = {
      BOT_TELEGRAM_MODE: 'polling',
      BOT_SIGNING_ENABLED: 'true',
      BOT_API_BASE_URL: 'http://api:3001',
      BOT_CREDENTIAL_FILE: '/run/secrets/bot_credential',
      BOT_CREDENTIAL_GID: '29002',
      TELEGRAM_BOT_TOKEN_FILE: '/run/secrets/telegram_token',
    };
    expect(() => parseBotEnvironment(base)).toThrow(
      /TELEGRAM_MINI_APP_BASE_URL/,
    );
    for (const value of [
      'http://t.me/meteora_test_bot/cabinet',
      'not-a-url',
      'https://example.com/meteora_test_bot/cabinet',
      'https://t.me/meteora_test_bot/cabinet?startapp=predefined',
      'https://t.me/not-a-bot/cabinet',
    ]) {
      expect(() =>
        parseBotEnvironment({
          ...base,
          TELEGRAM_MINI_APP_BASE_URL: value,
        }),
      ).toThrow(/direct Telegram Mini App link/);
    }
  });

  it('accepts only the approved internal plaintext API origin', () => {
    expect(
      parseBotEnvironment({
        BOT_SIGNING_ENABLED: 'true',
        BOT_API_BASE_URL: 'http://api:3001',
        BOT_CREDENTIAL_FILE: '/run/secrets/bot_credential',
        BOT_CREDENTIAL_GID: '29002',
      }),
    ).toMatchObject({
      BOT_SIGNING_ENABLED: true,
      BOT_API_BASE_URL: 'http://api:3001',
      BOT_CREDENTIAL_GID: 29002,
    });
    for (const value of [
      'https://api:3001',
      'http://api:3002',
      'http://external.example.test:3001',
      'http://api:3001/path',
    ]) {
      expect(() =>
        parseBotEnvironment({
          BOT_SIGNING_ENABLED: 'true',
          BOT_API_BASE_URL: value,
          BOT_CREDENTIAL_FILE: '/run/secrets/bot_credential',
          BOT_CREDENTIAL_GID: '29002',
        }),
      ).toThrow(/internal API origin/);
    }
  });

  it('fails closed without an absolute credential file', () => {
    expect(() =>
      parseBotEnvironment({
        BOT_SIGNING_ENABLED: 'true',
        BOT_API_BASE_URL: 'http://api:3001',
      }),
    ).toThrow(/BOT_CREDENTIAL_FILE/);
  });
});
