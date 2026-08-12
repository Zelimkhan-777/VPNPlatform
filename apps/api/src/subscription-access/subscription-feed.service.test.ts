import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { SubscriptionFeedService } from './subscription-feed.service';

describe('SubscriptionFeedService', () => {
  it('returns an empty safe feed only after server-side access verification', async () => {
    const resolveDeviceId = vi.fn().mockResolvedValue('device-id');
    const service = new SubscriptionFeedService({ resolveDeviceId } as never);

    await expect(service.feed('a'.repeat(43))).resolves.toBe('');
    expect(resolveDeviceId).toHaveBeenCalledWith('a'.repeat(43));
  });

  it('rejects every denied token without returning a feed', async () => {
    const service = new SubscriptionFeedService({
      resolveDeviceId: vi.fn().mockResolvedValue(null),
    } as never);

    await expect(service.feed('a'.repeat(43))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
