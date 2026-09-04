import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  activateTrialRequestSchema,
  trialActivationSchema,
  trialCampaignMetadataSchema,
  trialDurationDaysSchema,
} from '../src/trials';

describe('trial contracts', () => {
  it.each([1, 3, 5])('accepts the product duration %i', (durationDays) => {
    expect(trialDurationDaysSchema.parse(durationDays)).toBe(durationDays);
  });

  it.each([0, 2, 4, 6, 30])(
    'rejects unsupported duration %i',
    (durationDays) => {
      expect(trialDurationDaysSchema.safeParse(durationDays).success).toBe(
        false,
      );
    },
  );

  it('accepts only a Telegram identity for activation', () => {
    expect(
      activateTrialRequestSchema.parse({ telegramUserId: '123456789' }),
    ).toEqual({ telegramUserId: '123456789' });
    expect(
      activateTrialRequestSchema.safeParse({
        telegramUserId: '123456789',
        campaignId: randomUUID(),
      }).success,
    ).toBe(false);
  });

  it('validates campaign metadata without a user-facing secret', () => {
    const campaign = {
      id: randomUUID(),
      planId: randomUUID(),
      durationDays: 3,
      maxActivations: null,
      startsAt: null,
      endsAt: '2026-09-30T00:00:00.000Z',
      isActive: true,
      comment: null,
      archivedAt: null,
    };
    expect(trialCampaignMetadataSchema.parse(campaign)).toEqual(campaign);
    expect(
      trialCampaignMetadataSchema.safeParse({
        ...campaign,
        secret: 'must-not-exist',
      }).success,
    ).toBe(false);
  });

  it('validates the stable activation result', () => {
    const activation = {
      id: randomUUID(),
      trialCampaignId: randomUUID(),
      subscriptionId: randomUUID(),
      planId: randomUUID(),
      startsAt: '2026-09-04T00:00:00.000Z',
      expiresAt: '2026-09-07T00:00:00.000Z',
      activatedAt: '2026-09-04T00:00:00.000Z',
    };
    expect(trialActivationSchema.parse(activation)).toEqual(activation);
  });
});
