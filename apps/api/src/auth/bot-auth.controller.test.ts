import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { BotAuthChallengeService } from './bot-auth-challenge.service';
import { BotAuthController } from './bot-auth.controller';
import type { AuthenticatedBotRequest } from './bot-request-authentication.service';

const authenticated: AuthenticatedBotRequest = {
  credentialId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: 'challenge-1',
  method: 'POST',
  path: '/auth/telegram/challenge',
  principalId: '22222222-2222-4222-8222-222222222222',
  requestHash: 'a'.repeat(64),
  telegramUserId: '123456789',
};

describe('BotAuthController', () => {
  it('uses only the identity established by the bot authentication guard', async () => {
    const issued = {
      launchId: 'a'.repeat(43),
      expiresAt: '2026-09-05T12:02:00.000Z',
    };
    const issue = vi.fn().mockResolvedValue(issued);
    const controller = new BotAuthController({
      issue,
    } as unknown as BotAuthChallengeService);

    await expect(
      controller.issueChallenge(
        { telegramUserId: authenticated.telegramUserId },
        { authenticatedBot: authenticated },
      ),
    ).resolves.toEqual(issued);
    expect(issue).toHaveBeenCalledWith(authenticated);
  });

  it.each([
    [{ telegramUserId: '987654321' }, { authenticatedBot: authenticated }],
    [{ telegramUserId: authenticated.telegramUserId }, {}],
    [
      { telegramUserId: authenticated.telegramUserId, extra: true },
      { authenticatedBot: authenticated },
    ],
  ])('rejects an unbound or malformed request', async (body, request) => {
    const controller = new BotAuthController({
      issue: vi.fn(),
    } as unknown as BotAuthChallengeService);
    await expect(
      controller.issueChallenge(body, request),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
