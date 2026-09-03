import { describe, expect, it } from 'vitest';

import {
  adminRoleSchema,
  authenticatedUserSchema,
  orderSchema,
  paymentSchema,
  planSchema,
  promoCodeMetadataSchema,
} from '../src';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-09-03T00:00:00.000Z';

describe('application Stage B contracts', () => {
  it('keeps cabinet identity separate from admin membership', () => {
    expect(
      authenticatedUserSchema.safeParse({ id: firstId, role: 'CUSTOMER' })
        .success,
    ).toBe(true);
    expect(
      authenticatedUserSchema.safeParse({ id: firstId, role: 'ADMIN' }).success,
    ).toBe(false);
    expect(adminRoleSchema.options).toEqual([
      'OWNER',
      'OPERATOR',
      'SUPPORT',
      'FINANCE',
      'AUDITOR',
    ]);
  });

  it('requires plan duration as data', () => {
    const input = {
      id: firstId,
      code: 'STARTER',
      name: 'Starter',
      priceMinor: 20_000,
      currency: 'RUB',
      durationDays: 30,
      deviceLimit: 3,
      isActive: true,
    };

    expect(planSchema.safeParse(input).success).toBe(true);
    expect(planSchema.safeParse({ ...input, priceMinor: 0 }).success).toBe(
      false,
    );
    expect(planSchema.safeParse({ ...input, durationDays: 0 }).success).toBe(
      false,
    );
    expect(planSchema.safeParse({ ...input, durationDays: 367 }).success).toBe(
      false,
    );
    const withoutDuration: Partial<typeof input> = { ...input };
    delete withoutDuration.durationDays;
    expect(planSchema.safeParse(withoutDuration).success).toBe(false);
  });

  it('exposes only provider-neutral order and payment fields', () => {
    expect(
      orderSchema.safeParse({
        id: firstId,
        userId: secondId,
        planId: firstId,
        amountMinor: 20_000,
        currency: 'RUB',
        status: 'PENDING',
        createdAt: timestamp,
        updatedAt: timestamp,
      }).success,
    ).toBe(true);
    expect(
      paymentSchema.safeParse({
        id: firstId,
        orderId: secondId,
        providerPaymentId: null,
        amountMinor: 20_000,
        currency: 'RUB',
        status: 'PENDING',
        createdAt: timestamp,
        updatedAt: timestamp,
        webhookSignature: 'must-not-be-in-neutral-contract',
      }).success,
    ).toBe(false);
  });

  it('never exposes promo secret material in metadata', () => {
    const metadata = {
      id: firstId,
      planId: secondId,
      campaignName: 'Closed beta',
      durationDays: 7,
      maxUniqueUsers: 20,
      startsAt: null,
      endsAt: null,
      isActive: true,
      comment: null,
      archivedAt: null,
    };

    expect(promoCodeMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(
      promoCodeMetadataSchema.safeParse({
        ...metadata,
        secretHash: 'a'.repeat(64),
      }).success,
    ).toBe(false);
  });
});
