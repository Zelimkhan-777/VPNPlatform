import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { ApiEnvironment } from '../config/environment';
import type { RedisService } from '../redis/redis.service';
import { AuthIssuerRateLimiterService } from './auth-issuer-rate-limiter.service';

function service(result: number | Error) {
  const incrementWithExpiry =
    result instanceof Error
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue(result);
  return {
    incrementWithExpiry,
    limiter: new AuthIssuerRateLimiterService(
      { incrementWithExpiry } as unknown as RedisService,
      {
        AUTH_PRELAUNCH_RATE_LIMIT_MAX: 2,
        AUTH_PRELAUNCH_RATE_LIMIT_WINDOW_MS: 60_000,
      } as ApiEnvironment,
    ),
  };
}

describe('AuthIssuerRateLimiterService', () => {
  it('uses a Telegram-user namespace for initial login', async () => {
    const { incrementWithExpiry, limiter } = service(1);
    await expect(
      limiter.assertInitialAllowed('123456789'),
    ).resolves.toBeUndefined();
    expect(incrementWithExpiry).toHaveBeenCalledWith(
      'auth-initial:rate-limit:123456789',
      60_000,
    );
  });

  it('rejects an exceeded budget and fails closed on Redis errors', async () => {
    await expect(
      service(3).limiter.assertInitialAllowed('123'),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service(new Error('redis unavailable')).limiter.assertInitialAllowed(
        '123',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('uses separate principal and client namespaces for confirm and complete', async () => {
    const { incrementWithExpiry, limiter } = service(1);
    await limiter.assertConfirmationAllowed('principal-1', '123456789');
    await limiter.assertCompletionAllowed('192.0.2.10');
    expect(incrementWithExpiry).toHaveBeenNthCalledWith(
      1,
      'auth-confirm:rate-limit:principal-1:123456789',
      60_000,
    );
    expect(incrementWithExpiry).toHaveBeenNthCalledWith(
      2,
      'auth-complete:rate-limit:192.0.2.10',
      60_000,
    );
  });
});
