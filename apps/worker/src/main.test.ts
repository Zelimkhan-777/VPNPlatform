import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { parseWorkerEnvironment } from './environment';
import { attachSafeBullMqErrorListener, redisConnection } from './main';

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
        DATA_PLANE_CREDENTIAL_PEPPER: 'p'.repeat(43),
      }),
    ).toMatchObject({
      WORKER_ENABLED: true,
      WORKER_QUEUE_NAME: 'node-sync',
      WORKER_POLL_INTERVAL_MS: 1_000,
      WORKER_RETRY_DELAY_MS: 5_000,
      NODE_SYNC_RETRY_DELAY_MS: 30_000,
      NODE_SYNC_CONCURRENCY: 4,
      ACCESS_MAINTENANCE_INTERVAL_MS: 60_000,
      ACCESS_MAINTENANCE_BATCH_SIZE: 100,
      WORKER_COMPLETED_JOB_RETENTION_SECONDS: 604_800,
      WORKER_COMPLETED_JOB_RETENTION_COUNT: 10_000,
      WORKER_FAILED_JOB_RETENTION_SECONDS: 2_592_000,
      WORKER_FAILED_JOB_RETENTION_COUNT: 10_000,
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
    expect(() =>
      parseWorkerEnvironment({
        WORKER_ENABLED: 'true',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
        DATA_PLANE_CREDENTIAL_PEPPER: 'p'.repeat(43),
        ORCHESTRATION_LEASE_DURATION_MS: '30000',
        NODE_SYNC_RETRY_DELAY_MS: '5000',
      }),
    ).toThrow('must be at least ORCHESTRATION_LEASE_DURATION_MS');
    expect(() =>
      parseWorkerEnvironment({
        WORKER_ENABLED: 'true',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).toThrow('DATA_PLANE_CREDENTIAL_PEPPER');
    expect(() =>
      parseWorkerEnvironment({
        WORKER_COMPLETED_JOB_RETENTION_SECONDS: '0',
      }),
    ).toThrow();
    expect(() =>
      parseWorkerEnvironment({
        WORKER_FAILED_JOB_RETENTION_COUNT: '0',
      }),
    ).toThrow();
    expect(() =>
      parseWorkerEnvironment({ ACCESS_MAINTENANCE_INTERVAL_MS: '59999' }),
    ).toThrow();
    expect(() =>
      parseWorkerEnvironment({ ACCESS_MAINTENANCE_INTERVAL_MS: '60001' }),
    ).toThrow();
    expect(() =>
      parseWorkerEnvironment({ ACCESS_MAINTENANCE_BATCH_SIZE: '501' }),
    ).toThrow();
  });

  it('accepts bounded BullMQ retention overrides', () => {
    expect(
      parseWorkerEnvironment({
        WORKER_COMPLETED_JOB_RETENTION_SECONDS: '3600',
        WORKER_COMPLETED_JOB_RETENTION_COUNT: '50',
        WORKER_FAILED_JOB_RETENTION_SECONDS: '7200',
        WORKER_FAILED_JOB_RETENTION_COUNT: '75',
      }),
    ).toMatchObject({
      WORKER_COMPLETED_JOB_RETENTION_SECONDS: 3_600,
      WORKER_COMPLETED_JOB_RETENTION_COUNT: 50,
      WORKER_FAILED_JOB_RETENTION_SECONDS: 7_200,
      WORKER_FAILED_JOB_RETENTION_COUNT: 75,
    });
  });

  it('handles BullMQ errors without printing or serializing internal details', () => {
    const emitter = new EventEmitter();
    const error = vi.fn();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const sentinel = 'redis://worker:sentinel-credential@internal.example:6379';

    attachSafeBullMqErrorListener(emitter, 'bullmq-worker', { error } as never);
    expect(emitter.listenerCount('error')).toBe(1);
    expect(emitter.emit('error', new Error(sentinel))).toBe(true);

    expect(consoleError).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      {
        component: 'bullmq-worker',
        eventName: 'error',
        errorType: 'Error',
      },
      'BullMQ component reported an error',
    );
    const serialized = JSON.stringify(error.mock.calls);
    expect(serialized).not.toContain('sentinel-credential');
    expect(serialized).not.toContain('redis://');
    expect(serialized).not.toContain('internal.example');
    expect(serialized).not.toContain('stack');
    consoleError.mockRestore();
  });
});
