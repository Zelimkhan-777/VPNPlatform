import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  API_ENVIRONMENT,
  parseApiEnvironment,
} from '../src/config/environment';
import { PrismaService } from '../src/database/prisma.service';
import { InfrastructureDependencyChecker } from '../src/health/infrastructure-dependency-checker';
import { RedisService } from '../src/redis/redis.service';

const environment = parseApiEnvironment({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test?schema=public',
  REDIS_URL: 'redis://127.0.0.1:6379',
  HEALTH_CHECK_TIMEOUT_MS: '100',
});

async function createChecker(
  postgresPing: () => Promise<void>,
  redisPing: () => Promise<void>,
): Promise<InfrastructureDependencyChecker> {
  const testingModule = await Test.createTestingModule({
    providers: [
      InfrastructureDependencyChecker,
      { provide: API_ENVIRONMENT, useValue: environment },
      { provide: PrismaService, useValue: { ping: postgresPing } },
      { provide: RedisService, useValue: { ping: redisPing } },
    ],
  }).compile();

  return testingModule.get(InfrastructureDependencyChecker);
}

describe('InfrastructureDependencyChecker', () => {
  it('reports both dependencies as up after successful probes', async () => {
    const checker = await createChecker(
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(undefined),
    );

    await expect(checker.check()).resolves.toEqual({
      postgres: 'up',
      redis: 'up',
    });
  });

  it('isolates a failed dependency without exposing its error', async () => {
    const checker = await createChecker(
      vi.fn().mockResolvedValue(undefined),
      vi
        .fn()
        .mockRejectedValue(new Error('contains sensitive connection data')),
    );

    await expect(checker.check()).resolves.toEqual({
      postgres: 'up',
      redis: 'down',
    });
  });

  it('marks a probe down when it exceeds the configured timeout', async () => {
    const checker = await createChecker(
      vi.fn().mockImplementation(() => new Promise<void>(() => undefined)),
      vi.fn().mockResolvedValue(undefined),
    );

    await expect(checker.check()).resolves.toEqual({
      postgres: 'down',
      redis: 'up',
    });
  });
});
