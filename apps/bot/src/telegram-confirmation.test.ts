import { BOT_AUTH_HEADER_NAMES } from '@vpn-platform/contracts';
import { describe, expect, it, vi } from 'vitest';

import { BotRequestSigner } from './bot-api-client';
import {
  handleConfirmationMessage,
  parseConfirmationCode,
  TelegramConfirmationClient,
} from './telegram-confirmation';

describe('Telegram confirmation flow', () => {
  it('normalizes plain and command Crockford codes and ignores other text', () => {
    expect(parseConfirmationCode(' 01ab2cd3 ')).toBe('01AB2CD3');
    expect(parseConfirmationCode('/confirm 01ab2cd3')).toBe('01AB2CD3');
    expect(parseConfirmationCode('/confirm@meteora_bot 01ab2cd3')).toBe(
      '01AB2CD3',
    );
    expect(parseConfirmationCode('01IL2O03')).toBe('01112003');
    expect(parseConfirmationCode('hello')).toBeNull();
    expect(parseConfirmationCode('01IL2OU3')).toBeNull();
  });

  it('uses Telegram update identity and does not call API for unrelated text', async () => {
    const confirm = vi.fn().mockResolvedValue('rejected');
    await expect(
      handleConfirmationMessage(
        { text: 'hello', telegramUserId: '123456789', updateId: 41 },
        { confirm },
      ),
    ).resolves.toBeNull();
    await expect(
      handleConfirmationMessage(
        { text: '01ab2cd3', telegramUserId: '123456789', updateId: 42 },
        { confirm },
      ),
    ).resolves.toBe(
      'Не удалось подтвердить код. Проверьте код или запросите новый.',
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith({
      telegramUserId: '123456789',
      confirmationCode: '01AB2CD3',
      updateId: 42,
    });
  });

  it('binds identity, code and stable Telegram update id into a signed request', async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'BOT_CONFIRMED' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const signer = new BotRequestSigner(
      '550e8400-e29b-41d4-a716-446655440000',
      Buffer.alloc(32, 7).toString('base64url'),
      { now: () => 1_788_436_800_000, nonce: () => '0123456789abcdef' },
    );
    const client = new TelegramConfirmationClient(
      'http://api:3001',
      signer,
      request,
    );

    await expect(
      client.confirm({
        telegramUserId: '123456789',
        confirmationCode: '01AB2CD3',
        updateId: 42,
      }),
    ).resolves.toBe('confirmed');
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api:3001/auth/telegram/confirm');
    expect(init.body?.toString()).toBe(
      '{"telegramUserId":"123456789","confirmationCode":"01AB2CD3"}',
    );
    expect(init.headers).toMatchObject({
      [BOT_AUTH_HEADER_NAMES.idempotencyKey]: 'telegram-update-42',
      'content-type': 'application/json',
    });
    signer.destroy();
  });

  it('returns only generic rejected or unavailable outcomes', async () => {
    const signer = new BotRequestSigner(
      '550e8400-e29b-41d4-a716-446655440000',
      Buffer.alloc(32, 7).toString('base64url'),
    );
    for (const [response, expected] of [
      [new Response(null, { status: 401 }), 'rejected'],
      [new Response(null, { status: 429 }), 'unavailable'],
      [new Response('invalid', { status: 200 }), 'unavailable'],
    ] as const) {
      const client = new TelegramConfirmationClient(
        'http://api:3001',
        signer,
        vi.fn().mockResolvedValue(response),
      );
      await expect(
        client.confirm({
          telegramUserId: '123456789',
          confirmationCode: '01AB2CD3',
          updateId: 42,
        }),
      ).resolves.toBe(expected);
    }
    signer.destroy();
  });
});
