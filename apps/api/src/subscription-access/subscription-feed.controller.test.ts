import { describe, expect, it, vi } from 'vitest';

import { SubscriptionFeedController } from './subscription-feed.controller';

describe('SubscriptionFeedController', () => {
  it('rate limits before resolving a subscription feed', async () => {
    const assertAllowed = vi.fn().mockResolvedValue(undefined);
    const feed = vi.fn().mockResolvedValue('');
    const controller = new SubscriptionFeedController(
      { feed } as never,
      { assertAllowed } as never,
    );

    await expect(
      controller.feed('a'.repeat(43), { ip: '192.0.2.1' }),
    ).resolves.toBe('');
    expect(assertAllowed).toHaveBeenCalledWith('192.0.2.1');
    expect(feed).toHaveBeenCalledWith('a'.repeat(43));
  });
});
