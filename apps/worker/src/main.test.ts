import { describe, expect, it } from 'vitest';

import { parseWorkerEnvironment } from './environment';
import { redisConnection } from './main';

describe('worker configuration', () => {
  it('keeps the worker disabled by default', () => {
    expect(parseWorkerEnvironment({}).WORKER_ENABLED).toBe(false);
  });

  it('requires PostgreSQL and Redis when enabled', () => {
    expect(() => parseWorkerEnvironment({ WORKER_ENABLED: 'true' })).toThrow();
    expect(
      parseWorkerEnvironment({
        WORKER_ENABLED: 'true',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).toMatchObject({
      WORKER_ENABLED: true,
      WORKER_QUEUE_NAME: 'node-sync',
      WORKER_POLL_INTERVAL_MS: 1_000,
      WORKER_RETRY_DELAY_MS: 5_000,
    });
  });

  it('rejects invalid switches and connection protocols', () => {
    expect(() => parseWorkerEnvironment({ WORKER_ENABLED: 'yes' })).toThrow();
    expect(() => redisConnection('https://redis.example.test')).toThrow(
      'REDIS_URL must use the redis or rediss protocol',
    );
    expect(() => redisConnection('redis://localhost/not-a-database')).toThrow(
      'REDIS_URL database must be a non-negative integer',
    );
    expect(redisConnection('redis://localhost/2')).toMatchObject({ db: 2 });
  });
});
