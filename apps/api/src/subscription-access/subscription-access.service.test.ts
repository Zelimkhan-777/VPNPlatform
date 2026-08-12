import { describe, expect, it, vi } from 'vitest';

import { SubscriptionAccessService } from './subscription-access.service';

const pepper = 'subscription-token-pepper-for-local-tests';

describe('SubscriptionAccessService', () => {
  it('resolves only an active device with an unexpired active subscription', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'device-id' });
    const service = new SubscriptionAccessService(
      { device: { findFirst } } as never,
      { SUBSCRIPTION_TOKEN_PEPPER: pepper } as never,
    );
    const token = 'a'.repeat(43);
    const now = new Date('2026-08-12T12:00:00.000Z');

    await expect(service.resolveDeviceId(token, now)).resolves.toBe(
      'device-id',
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        subscriptionTokenHash: service.hashToken(token, pepper),
        status: 'ACTIVE',
        user: {
          subscriptions: {
            some: { status: 'ACTIVE', expiresAt: { gt: now } },
          },
        },
      },
      select: { id: true },
    });
  });

  it('does not query or reveal why a malformed token is denied', async () => {
    const findFirst = vi.fn();
    const service = new SubscriptionAccessService(
      { device: { findFirst } } as never,
      { SUBSCRIPTION_TOKEN_PEPPER: pepper } as never,
    );

    await expect(service.resolveDeviceId('not-a-token')).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});
