import { describe, expect, it } from 'vitest';

import { createApiPinoHttpOptions } from './app.module';

describe('Pino redaction', () => {
  it.each([
    [
      'Authorization',
      { req: { headers: { authorization: 'Bearer auth-secret' } } },
      'auth-secret',
    ],
    [
      'Cookie session secret',
      { req: { headers: { cookie: 'vpn_platform_session=session-secret' } } },
      'session-secret',
    ],
    [
      'Cookie pre-launch secret',
      {
        req: { headers: { cookie: 'vpn_platform_prelaunch=prelaunch-secret' } },
      },
      'prelaunch-secret',
    ],
    [
      'Set-Cookie',
      {
        res: {
          headers: { 'set-cookie': 'vpn_platform_session=set-cookie-secret' },
        },
      },
      'set-cookie-secret',
    ],
    [
      'Idempotency-Key',
      { req: { headers: { 'idempotency-key': 'idempotency-secret' } } },
      'idempotency-secret',
    ],
    [
      'Telegram initData',
      { req: { body: { initData: 'telegram-init-data-secret' } } },
      'telegram-init-data-secret',
    ],
    [
      'body token',
      { req: { body: { token: 'body-token-secret' } } },
      'body-token-secret',
    ],
    [
      'subscription URL',
      {
        req: {
          body: {
            subscriptionUrl: 'https://sub.example.test/subscription-secret',
          },
        },
      },
      'subscription-secret',
    ],
    [
      'path token',
      { req: { params: { token: 'path-token-secret' } } },
      'path-token-secret',
    ],
    [
      'request URL',
      { req: { url: '/sub/request-url-secret' } },
      'request-url-secret',
    ],
  ] as const)('redacts %s values', (_name, payload, secret) => {
    const records: string[] = [];
    const logger = createApiPinoHttpOptions('info', {
      write: (record) => records.push(record),
    }).logger;

    logger.info(payload, 'request');

    expect(records.join('')).not.toContain(secret);
  });
});
