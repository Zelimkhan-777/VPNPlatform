import { BOT_AUTH_HEADER_NAMES } from '@vpn-platform/contracts';
import { describe, expect, it, vi } from 'vitest';

import { BotRequestSigner } from './bot-api-client';
import {
  handleLoginLaunchMessage,
  TelegramLoginLaunchClient,
} from './telegram-login-launch';

describe('Telegram login launch flow', () => {
  it('recognizes only explicit start and cabinet commands', async () => {
    const issue = vi.fn().mockResolvedValue({ kind: 'rejected' });
    for (const text of ['/start', '/cabinet', '/cabinet@meteora_bot']) {
      await expect(
        handleLoginLaunchMessage(
          { text, telegramUserId: '123456789', updateId: 42 },
          { issue },
          'https://t.me/meteora_test_bot/cabinet',
        ),
      ).resolves.toEqual({ text: 'Кабинет пока недоступен.' });
    }
    await expect(
      handleLoginLaunchMessage(
        {
          text: '/start untrusted-payload',
          telegramUserId: '123456789',
          updateId: 43,
        },
        { issue },
        'https://t.me/meteora_test_bot/cabinet',
      ),
    ).resolves.toBeNull();
    expect(issue).toHaveBeenCalledTimes(3);
  });

  it('signs the challenge request with Telegram identity and stable update id', async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          launchId: 'a'.repeat(43),
          expiresAt: '2026-09-06T09:00:00.000Z',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    const signer = new BotRequestSigner(
      '550e8400-e29b-41d4-a716-446655440000',
      Buffer.alloc(32, 7).toString('base64url'),
      { now: () => 1_788_436_800_000, nonce: () => '0123456789abcdef' },
    );
    const client = new TelegramLoginLaunchClient(
      'http://api:3001',
      signer,
      request,
    );

    await expect(
      client.issue({ telegramUserId: '123456789', updateId: 42 }),
    ).resolves.toEqual({
      kind: 'issued',
      launchId: 'a'.repeat(43),
      expiresAt: '2026-09-06T09:00:00.000Z',
    });
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api:3001/auth/telegram/challenge');
    expect(init.body?.toString()).toBe('{"telegramUserId":"123456789"}');
    expect(init.headers).toMatchObject({
      [BOT_AUTH_HEADER_NAMES.idempotencyKey]: 'telegram-challenge-42',
      'content-type': 'application/json',
    });
    signer.destroy();
  });

  it('puts only the opaque launch id into the Telegram startapp parameter', async () => {
    const reply = await handleLoginLaunchMessage(
      { text: '/cabinet', telegramUserId: '123456789', updateId: 42 },
      {
        issue: vi.fn().mockResolvedValue({
          kind: 'issued',
          launchId: 'a'.repeat(43),
          expiresAt: '2026-09-06T09:00:00.000Z',
        }),
      },
      'https://t.me/meteora_test_bot/cabinet',
    );

    expect(reply).toEqual({
      text: 'Откройте кабинет. После появления кода отправьте его сюда.',
      miniAppUrl: `https://t.me/meteora_test_bot/cabinet?startapp=${'a'.repeat(43)}`,
    });
  });

  it('returns generic failures without exposing API details', async () => {
    const signer = new BotRequestSigner(
      '550e8400-e29b-41d4-a716-446655440000',
      Buffer.alloc(32, 7).toString('base64url'),
    );
    for (const [response, expected] of [
      [new Response(null, { status: 409 }), { kind: 'rejected' }],
      [new Response(null, { status: 429 }), { kind: 'unavailable' }],
      [new Response('invalid', { status: 201 }), { kind: 'unavailable' }],
    ] as const) {
      const client = new TelegramLoginLaunchClient(
        'http://api:3001',
        signer,
        vi.fn().mockResolvedValue(response),
      );
      await expect(
        client.issue({ telegramUserId: '123456789', updateId: 42 }),
      ).resolves.toEqual(expected);
    }
    signer.destroy();
  });
});
