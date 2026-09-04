import { createHash, createHmac } from 'node:crypto';

import {
  BOT_AUTH_HEADER_NAMES,
  createBotRequestCanonicalString,
} from '@vpn-platform/contracts';
import { describe, expect, it } from 'vitest';

import { BotRequestSigner } from './bot-api-client';

describe('BotRequestSigner', () => {
  it('signs exact body bytes and every execution-scope field', () => {
    const credentialId = '550e8400-e29b-41d4-a716-446655440000';
    const signingKey = Buffer.alloc(32, 9);
    const body = Buffer.from('{ "telegramUserId": "123456789" }');
    const signer = new BotRequestSigner(
      credentialId,
      signingKey.toString('base64url'),
      {
        now: () => 1_788_436_800_000,
        nonce: () => '0123456789abcdef',
      },
    );

    const signed = signer.sign({
      method: 'POST',
      path: '/internal/bot/auth/confirm',
      telegramUserId: '123456789',
      idempotencyKey: 'confirm-1',
      body,
    });
    const expected = createHmac('sha256', signingKey)
      .update(
        createBotRequestCanonicalString({
          credentialId,
          method: 'POST',
          path: '/internal/bot/auth/confirm',
          timestamp: '1788436800',
          nonce: '0123456789abcdef',
          telegramUserId: '123456789',
          idempotencyKey: 'confirm-1',
          rawBodySha256: createHash('sha256').update(body).digest('hex'),
        }),
      )
      .digest('hex');

    expect(signed.body).toBe(body);
    expect(signed.headers).toMatchObject({
      [BOT_AUTH_HEADER_NAMES.credentialId]: credentialId,
      [BOT_AUTH_HEADER_NAMES.idempotencyKey]: 'confirm-1',
      [BOT_AUTH_HEADER_NAMES.nonce]: '0123456789abcdef',
      [BOT_AUTH_HEADER_NAMES.signature]: expected,
      [BOT_AUTH_HEADER_NAMES.timestamp]: '1788436800',
    });
    signer.destroy();
  });

  it('uses a fresh nonce while preserving the caller idempotency key', () => {
    const nonces = ['0123456789abcdef', 'fedcba9876543210'];
    const signer = new BotRequestSigner(
      '550e8400-e29b-41d4-a716-446655440000',
      Buffer.alloc(32, 7).toString('base64url'),
      { nonce: () => nonces.shift() ?? 'unexpected-nonce' },
    );
    const input = {
      method: 'POST',
      path: '/internal/bot/retry',
      telegramUserId: '123456789',
      idempotencyKey: 'stable-operation-1',
      body: Buffer.from('{}'),
    };

    const first = signer.sign(input);
    const retry = signer.sign(input);

    expect(first.headers[BOT_AUTH_HEADER_NAMES.idempotencyKey]).toBe(
      retry.headers[BOT_AUTH_HEADER_NAMES.idempotencyKey],
    );
    expect(first.headers[BOT_AUTH_HEADER_NAMES.nonce]).not.toBe(
      retry.headers[BOT_AUTH_HEADER_NAMES.nonce],
    );
    expect(first.headers[BOT_AUTH_HEADER_NAMES.signature]).not.toBe(
      retry.headers[BOT_AUTH_HEADER_NAMES.signature],
    );
    signer.destroy();
  });
});
