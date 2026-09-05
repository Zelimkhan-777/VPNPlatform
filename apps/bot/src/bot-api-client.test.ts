import { createHash, createHmac } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BOT_AUTH_HEADER_NAMES,
  createBotRequestCanonicalString,
} from '@vpn-platform/contracts';
import { describe, expect, it } from 'vitest';

import { BotRequestSigner, readTelegramBotTokenFile } from './bot-api-client';

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

describe('Telegram bot token file', () => {
  it('accepts one private token line and rejects malformed material', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telegram-token-test-'));
    const path = join(directory, 'token');
    try {
      await writeFile(path, '123456:abcdefghijklmnopqrstuvwxyz_ABCDE\n', {
        mode: 0o600,
      });
      expect(readTelegramBotTokenFile(path)).toBe(
        '123456:abcdefghijklmnopqrstuvwxyz_ABCDE',
      );
      if (process.platform !== 'win32') {
        await chmod(path, 0o644);
        expect(() => readTelegramBotTokenFile(path)).toThrow(
          /permissions are invalid/,
        );
      }
      await unlink(path);
      await writeFile(path, 'not-a-token\n', { mode: 0o600 });
      expect(() => readTelegramBotTokenFile(path)).toThrow(
        /token file value is invalid/,
      );
      await unlink(path);
      try {
        await symlink(join(directory, 'missing'), path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EPERM') return;
        throw error;
      }
      expect(() => readTelegramBotTokenFile(path)).toThrow(
        /token file type is invalid/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
