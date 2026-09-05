import { describe, expect, it } from 'vitest';

import {
  issuedTelegramAuthChallengeSchema,
  issueTelegramAuthChallengeRequestSchema,
} from '../src';

describe('Telegram auth issuer contracts', () => {
  it('accepts only the signed bot Telegram identity input', () => {
    expect(
      issueTelegramAuthChallengeRequestSchema.safeParse({
        telegramUserId: '123456789',
      }).success,
    ).toBe(true);
    expect(
      issueTelegramAuthChallengeRequestSchema.safeParse({
        telegramUserId: '123456789',
        challengeSecret: 'must-not-cross-the-contract',
      }).success,
    ).toBe(false);
  });

  it('returns only an opaque launch id and expiry', () => {
    const value = {
      launchId: 'a'.repeat(43),
      expiresAt: '2026-09-05T12:02:00.000Z',
    };
    expect(issuedTelegramAuthChallengeSchema.parse(value)).toEqual(value);
    expect(
      issuedTelegramAuthChallengeSchema.safeParse({
        ...value,
        secret: 'must-not-be-returned',
      }).success,
    ).toBe(false);
  });
});
