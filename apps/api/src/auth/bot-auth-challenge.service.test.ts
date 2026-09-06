import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { ApiEnvironment } from '../config/environment';
import type { AuthenticatedBotRequest } from './bot-request-authentication.service';
import type { AuthIssuerRateLimiterService } from './auth-issuer-rate-limiter.service';
import type { BotRequestExecutionService } from './bot-request-execution.service';
import { BotAuthChallengeService } from './bot-auth-challenge.service';

const request: AuthenticatedBotRequest = {
  credentialId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: 'challenge-1',
  method: 'POST',
  path: '/auth/telegram/challenge',
  principalId: '22222222-2222-4222-8222-222222222222',
  requestHash: 'a'.repeat(64),
  telegramUserId: '123456789',
};

function harness(queryResults: unknown[][]) {
  const create = vi.fn().mockResolvedValue(undefined);
  const assertChallengeAllowed = vi.fn().mockResolvedValue(undefined);
  const transaction = {
    $queryRaw: vi.fn(),
    authChallenge: { create },
  };
  for (const result of queryResults) {
    transaction.$queryRaw.mockResolvedValueOnce(result);
  }
  const execute = vi.fn(
    async (
      _request: AuthenticatedBotRequest,
      operation: (input: typeof transaction) => Promise<unknown>,
    ) => {
      const result = (await operation(transaction)) as {
        statusCode: number;
        body: object;
      };
      return { ...result, replayed: false };
    },
  );
  const service = new BotAuthChallengeService(
    { execute } as unknown as BotRequestExecutionService,
    { assertChallengeAllowed } as unknown as AuthIssuerRateLimiterService,
    { AUTH_SESSION_PEPPER: 'p'.repeat(32) } as ApiEnvironment,
  );
  return { assertChallengeAllowed, create, execute, service, transaction };
}

describe('BotAuthChallengeService', () => {
  it('creates a user-bound 120-second challenge for confirmed entitlement', async () => {
    const now = new Date('2026-09-05T12:00:00.000Z');
    const { assertChallengeAllowed, create, service } = harness([
      [
        {
          id: '33333333-3333-4333-8333-333333333333',
          telegramUserId: '123456789',
        },
      ],
      [{ now }],
      [{ id: '44444444-4444-4444-8444-444444444444' }],
    ]);

    const issued = await service.issue(request);

    expect(issued.launchId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt).toBe('2026-09-05T12:02:00.000Z');
    expect(create).toHaveBeenCalledWith({
      data: {
        launchId: issued.launchId,
        tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        userId: '33333333-3333-4333-8333-333333333333',
        createdAt: now,
        expiresAt: new Date('2026-09-05T12:02:00.000Z'),
      },
    });
    expect(JSON.stringify(issued)).not.toContain('tokenHash');
    expect(assertChallengeAllowed).toHaveBeenCalledWith(
      request.principalId,
      request.telegramUserId,
    );
  });

  it.each([
    {
      name: 'unknown user',
      results: [[], [{ now: new Date() }], [{ id: 'unused' }]],
    },
    {
      name: 'no confirmed entitlement',
      results: [
        [
          {
            id: '33333333-3333-4333-8333-333333333333',
            telegramUserId: '123456789',
          },
        ],
        [{ now: new Date() }],
        [],
      ],
    },
  ] satisfies { name: string; results: unknown[][] }[])(
    '$name',
    async ({ results }) => {
      const { create, service } = harness(results);
      await expect(service.issue(request)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the session pepper is unavailable', async () => {
    const execute = vi.fn();
    const service = new BotAuthChallengeService(
      { execute } as unknown as BotRequestExecutionService,
      {
        assertChallengeAllowed: vi.fn(),
      } as unknown as AuthIssuerRateLimiterService,
      {} as ApiEnvironment,
    );
    await expect(service.issue(request)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails before database mutation when the challenge limiter is unavailable', async () => {
    const failure = new ServiceUnavailableException(
      'Telegram login is unavailable',
    );
    const { assertChallengeAllowed, create, service, transaction } = harness(
      [],
    );
    assertChallengeAllowed.mockRejectedValue(failure);

    await expect(service.issue(request)).rejects.toBe(failure);
    expect(assertChallengeAllowed).toHaveBeenCalledOnce();
    expect(transaction.$queryRaw).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
