import { HttpStatus } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { parseApiEnvironment } from '../config/environment';
import { SubscriptionFeedRateLimiterService } from './subscription-feed-rate-limiter.service';

describe('SubscriptionFeedRateLimiterService', () => {
  it('uses the shared Redis counter and rejects requests over the configured limit', async () => {
    const incrementWithExpiry = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    const limiter = new SubscriptionFeedRateLimiterService(
      parseApiEnvironment({
        NODE_ENV: 'test',
        DATABASE_URL:
          'postgresql://test:test@127.0.0.1:5432/test?schema=public',
        REDIS_URL: 'redis://127.0.0.1:6379',
        SUBSCRIPTION_FEED_RATE_LIMIT_MAX: '1',
        SUBSCRIPTION_FEED_RATE_LIMIT_WINDOW_MS: '1000',
      }),
      { incrementWithExpiry } as never,
    );

    await expect(limiter.assertAllowed('192.0.2.1')).resolves.toBeUndefined();
    await expect(limiter.assertAllowed('192.0.2.1')).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(incrementWithExpiry).toHaveBeenNthCalledWith(
      1,
      'subscription-feed:rate-limit:192.0.2.1',
      1_000,
    );
  });
});
