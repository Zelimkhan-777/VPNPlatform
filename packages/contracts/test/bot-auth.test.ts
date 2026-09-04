import { describe, expect, it } from 'vitest';

import {
  botRequestPathSchema,
  botSignedRequestHeadersSchema,
  botTelegramIdentitySchema,
  createBotRequestCanonicalString,
  parseBotCredentialFile,
  serializeBotCredentialFile,
} from '../src';

describe('bot request authentication contract', () => {
  it('builds the approved newline-delimited canonical string', () => {
    expect(
      createBotRequestCanonicalString({
        credentialId: '11111111-1111-4111-8111-111111111111',
        method: 'POST',
        path: '/internal/bot/auth/confirm',
        timestamp: '1788436800',
        nonce: 'nonce-for-contract',
        telegramUserId: '123456789',
        idempotencyKey: 'login-confirmation-1',
        rawBodySha256: 'a'.repeat(64),
      }),
    ).toBe(
      [
        '11111111-1111-4111-8111-111111111111',
        'POST',
        '/internal/bot/auth/confirm',
        '1788436800',
        'nonce-for-contract',
        '123456789',
        'login-confirmation-1',
        'a'.repeat(64),
      ].join('\n'),
    );
  });

  it('accepts only singular, canonical authentication fields', () => {
    expect(
      botSignedRequestHeadersSchema.safeParse({
        credentialId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: 'login-confirmation-1',
        timestamp: '1788436800',
        nonce: '0123456789abcdef',
        signature: 'a'.repeat(64),
      }).success,
    ).toBe(true);
    expect(
      botSignedRequestHeadersSchema.safeParse({
        credentialId: 'not-a-credential',
        idempotencyKey: 'contains whitespace',
        timestamp: '+1788436800',
        nonce: 'short',
        signature: 'A'.repeat(64),
      }).success,
    ).toBe(false);
  });

  it('rejects unsigned query semantics and invalid Telegram identities', () => {
    expect(
      botRequestPathSchema.safeParse('/internal/bot?admin=true').success,
    ).toBe(false);
    expect(
      botTelegramIdentitySchema.safeParse({ telegramUserId: '0' }).success,
    ).toBe(false);
    expect(
      botTelegramIdentitySchema.safeParse({ telegramUserId: '123456789' })
        .success,
    ).toBe(true);
  });
});

describe('bot credential file contract', () => {
  const credential = {
    formatVersion: 1 as const,
    credentialId: '550e8400-e29b-41d4-a716-446655440000',
    signingKey: 'A'.repeat(43),
  };

  it('round-trips one strict versioned JSON line', () => {
    expect(
      parseBotCredentialFile(serializeBotCredentialFile(credential)),
    ).toEqual(credential);
  });

  it('rejects extra fields, malformed key material and multiple lines', () => {
    expect(() =>
      parseBotCredentialFile(
        `${JSON.stringify({ ...credential, extra: true })}\n`,
      ),
    ).toThrow(/invalid/);
    expect(() =>
      parseBotCredentialFile(
        `${JSON.stringify({ ...credential, signingKey: 'short' })}\n`,
      ),
    ).toThrow(/invalid/);
    expect(() =>
      parseBotCredentialFile(`${JSON.stringify(credential)}\nignored\n`),
    ).toThrow(/one JSON line/);
  });
});
