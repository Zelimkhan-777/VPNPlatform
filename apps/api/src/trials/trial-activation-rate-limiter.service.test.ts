import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { ApiEnvironment } from '../config/environment';
import type { RedisService } from '../redis/redis.service';
import { TrialActivationRateLimiterService } from './trial-activation-rate-limiter.service';

const environment = {
  TRIAL_ACTIVATION_RATE_LIMIT_MAX: 2,
  TRIAL_ACTIVATION_RATE_LIMIT_WINDOW_MS: 60_000,
} as ApiEnvironment;

describe('TrialActivationRateLimiterService', () => {
  it('scopes attempts to the bot principal and Telegram identity', async () => {
    const incrementWithExpiry = vi.fn().mockResolvedValueOnce(1);
    const service = new TrialActivationRateLimiterService(environment, {
      incrementWithExpiry,
    } as unknown as RedisService);

    await expect(
      service.assertAllowed('principal-1', '123'),
    ).resolves.toBeUndefined();
    expect(incrementWithExpiry).toHaveBeenCalledWith(
      'trial-activation:rate-limit:principal-1:123',
      60_000,
    );
  });

  it('rejects attempts above the configured limit', async () => {
    const service = new TrialActivationRateLimiterService(environment, {
      incrementWithExpiry: vi.fn().mockResolvedValue(3),
    } as unknown as RedisService);

    await expect(
      service.assertAllowed('principal-1', '123'),
    ).rejects.toMatchObject({
      status: 429,
    });
  });

  it('fails closed when Redis is unavailable', async () => {
    const service = new TrialActivationRateLimiterService(environment, {
      incrementWithExpiry: vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as RedisService);

    await expect(
      service.assertAllowed('principal-1', '123'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
