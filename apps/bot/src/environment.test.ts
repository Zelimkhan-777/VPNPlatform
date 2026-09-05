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
      }),
    ).toMatchObject({
      BOT_TELEGRAM_MODE: 'polling',
      TELEGRAM_BOT_TOKEN_FILE: '/run/secrets/telegram_token',
    });
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
