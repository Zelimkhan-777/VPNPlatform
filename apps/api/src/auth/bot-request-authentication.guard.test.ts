import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { BotRequestAuthenticationGuard } from './bot-request-authentication.guard';
import type { BotRequestAuthenticationService } from './bot-request-authentication.service';

const authenticatedBot = {
  credentialId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: 'login-confirmation-1',
  method: 'POST',
  path: '/internal/bot/auth/confirm',
  principalId: '22222222-2222-4222-8222-222222222222',
  requestHash: 'b'.repeat(64),
  telegramUserId: '123456789',
};

function validRequest() {
  return {
    body: { telegramUserId: authenticatedBot.telegramUserId, code: 'ABC' },
    headers: {
      'x-bot-credential-id': authenticatedBot.credentialId,
      'idempotency-key': authenticatedBot.idempotencyKey,
      'x-bot-nonce': '0123456789abcdef',
      'x-bot-signature': 'a'.repeat(64),
      'x-bot-timestamp': '1788436800',
    },
    method: 'POST',
    raw: { url: '/internal/bot/auth/confirm' },
    rawBody: Buffer.from(
      JSON.stringify({
        telegramUserId: authenticatedBot.telegramUserId,
        code: 'ABC',
      }),
    ),
  };
}

function requestContext(
  request: ReturnType<typeof validRequest>,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

describe('BotRequestAuthenticationGuard', () => {
  it('publishes identity only after successful authentication', async () => {
    const authenticate = vi.fn().mockResolvedValue(authenticatedBot);
    const guard = new BotRequestAuthenticationGuard({
      authenticate,
    } as unknown as BotRequestAuthenticationService);
    const incoming = validRequest();

    await expect(guard.canActivate(requestContext(incoming))).resolves.toBe(
      true,
    );
    expect(incoming).toHaveProperty('authenticatedBot', authenticatedBot);
    expect(authenticate).toHaveBeenCalledWith({
      credentialId: authenticatedBot.credentialId,
      idempotencyKey: authenticatedBot.idempotencyKey,
      method: 'POST',
      path: '/internal/bot/auth/confirm',
      timestamp: '1788436800',
      nonce: '0123456789abcdef',
      signature: 'a'.repeat(64),
      telegramUserId: authenticatedBot.telegramUserId,
      rawBody: incoming.rawBody,
    });
  });

  it.each([
    [
      'missing signature',
      (request: ReturnType<typeof validRequest>) =>
        (request.headers['x-bot-signature'] = ''),
    ],
    [
      'missing idempotency key',
      (request: ReturnType<typeof validRequest>) =>
        (request.headers['idempotency-key'] = ''),
    ],
    [
      'missing raw body',
      (request: ReturnType<typeof validRequest>) =>
        (request.rawBody = undefined as never),
    ],
    [
      'unsigned query',
      (request: ReturnType<typeof validRequest>) =>
        (request.raw.url = '/internal/bot/auth/confirm?admin=true'),
    ],
    [
      'body-only identity',
      (request: ReturnType<typeof validRequest>) =>
        (request.headers['x-bot-credential-id'] = ''),
    ],
  ])('returns the same 401 for %s', async (_scenario, mutate) => {
    const authenticate = vi.fn();
    const guard = new BotRequestAuthenticationGuard({
      authenticate,
    } as unknown as BotRequestAuthenticationService);
    const incoming = validRequest();
    mutate(incoming);

    await expect(guard.canActivate(requestContext(incoming))).rejects.toEqual(
      new UnauthorizedException('Bot request is invalid'),
    );
    expect(authenticate).not.toHaveBeenCalled();
    expect(incoming).not.toHaveProperty('authenticatedBot');
  });

  it('returns the same 401 when cryptographic authentication fails', async () => {
    const guard = new BotRequestAuthenticationGuard({
      authenticate: vi.fn().mockResolvedValue(null),
    } as unknown as BotRequestAuthenticationService);
    const incoming = validRequest();

    await expect(guard.canActivate(requestContext(incoming))).rejects.toEqual(
      new UnauthorizedException('Bot request is invalid'),
    );
    expect(incoming).not.toHaveProperty('authenticatedBot');
  });
});
