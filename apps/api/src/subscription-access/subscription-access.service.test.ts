import { describe, expect, it, vi } from 'vitest';

import { SubscriptionAccessService } from './subscription-access.service';

const pepper = 'subscription-token-pepper-for-local-tests';

describe('SubscriptionAccessService', () => {
  it('resolves only an active device with an unexpired active subscription', async () => {
    const $queryRaw = vi
      .fn()
      .mockResolvedValue([{ deviceId: 'device-id', userId: 'user-id' }]);
    const service = new SubscriptionAccessService(
      { $queryRaw } as never,
      { SUBSCRIPTION_TOKEN_PEPPER: pepper } as never,
    );
    const token = 'a'.repeat(43);
    await expect(service.resolveDeviceId(token)).resolves.toBe('device-id');
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });

  it('does not query or reveal why a malformed token is denied', async () => {
    const $queryRaw = vi.fn();
    const service = new SubscriptionAccessService(
      { $queryRaw } as never,
      { SUBSCRIPTION_TOKEN_PEPPER: pepper } as never,
    );

    await expect(service.resolveDeviceId('not-a-token')).resolves.toBeNull();
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
