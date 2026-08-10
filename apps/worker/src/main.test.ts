import { describe, expect, it } from 'vitest';

import {
  isWorkerEnabled,
  redisConnection,
  rejectUnregisteredJob,
} from './main';

describe('worker scaffold', () => {
  it('enables the worker only with an explicit true value', () => {
    expect(isWorkerEnabled(undefined)).toBe(false);
    expect(isWorkerEnabled('false')).toBe(false);
    expect(isWorkerEnabled('true')).toBe(true);
    expect(() => isWorkerEnabled('yes')).toThrow(
      'WORKER_ENABLED must be true or false',
    );
  });

  it('rejects jobs until a business processor is registered', () => {
    expect(() =>
      rejectUnregisteredJob({ id: 'test-job', name: 'unexpected-job' }),
    ).toThrow('No processor is registered for job: unexpected-job');
  });

  it('rejects Redis URLs with an unsupported protocol', () => {
    expect(() => redisConnection('https://redis.example.test')).toThrow(
      'REDIS_URL must use the redis or rediss protocol',
    );
  });
});
