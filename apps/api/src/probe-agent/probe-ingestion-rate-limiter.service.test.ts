import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { parseApiEnvironment } from '../config/environment';
import type { RedisService } from '../redis/redis.service';
import { ProbeIngestionRateLimiterService } from './probe-ingestion-rate-limiter.service';

const environment = parseApiEnvironment({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  PROBE_INGESTION_RATE_LIMIT_MAX: '2',
  PROBE_INGESTION_MAX_SCOPES_PER_WINDOW: '1',
});

describe('ProbeIngestionRateLimiterService', () => {
  it('limits both request count and distinct scope cardinality', async () => {
    const redis = {
      incrementWithExpiry: vi.fn().mockResolvedValue(2),
      incrementWithCardinality: vi
        .fn()
        .mockResolvedValueOnce({ attempts: 2, cardinality: 1 })
        .mockResolvedValueOnce({ attempts: 2, cardinality: 2 }),
    } as unknown as RedisService;
    const limiter = new ProbeIngestionRateLimiterService(environment, redis);

    await expect(limiter.assertIpAllowed('192.0.2.1')).resolves.toBeUndefined();
    await expect(
      limiter.assertSourceAllowed('source-id', { kind: 'NODE', id: 'node-a' }),
    ).resolves.toBeUndefined();
    await expect(
      limiter.assertSourceAllowed('source-id', { kind: 'NODE', id: 'node-b' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('fails closed when Redis is unavailable', async () => {
    const redis = {
      incrementWithExpiry: vi.fn().mockRejectedValue(new Error('offline')),
    } as unknown as RedisService;
    const limiter = new ProbeIngestionRateLimiterService(environment, redis);
    await expect(limiter.assertIpAllowed('192.0.2.1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
