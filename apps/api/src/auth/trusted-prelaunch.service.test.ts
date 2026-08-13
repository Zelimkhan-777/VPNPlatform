import { describe, expect, it, vi } from 'vitest';

import type { ApiEnvironment } from '../config/environment';
import type { PrismaService } from '../database/prisma.service';
import type { RedisService } from '../redis/redis.service';
import { TrustedPrelaunchService } from './trusted-prelaunch.service';

describe('TrustedPrelaunchService clock authority', () => {
  it('derives issuance and cleanup boundaries from PostgreSQL despite process clock skew', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));
    const databaseNow = new Date('2026-08-13T10:00:00.000Z');
    const create = vi.fn().mockResolvedValue(undefined);
    const findMany = vi.fn().mockResolvedValue([]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ now: databaseNow }]),
      authChallenge: { create, findMany, deleteMany },
    };
    const prisma = {
      $transaction: vi.fn(
        (callback: (client: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    } as unknown as PrismaService;
    const redis = {
      incrementWithExpiry: vi.fn().mockResolvedValue(1),
    } as unknown as RedisService;
    const environment = {
      AUTH_SESSION_PEPPER: 'a'.repeat(32),
      AUTH_PRELAUNCH_RATE_LIMIT_WINDOW_MS: 60_000,
      AUTH_PRELAUNCH_RATE_LIMIT_MAX: 10,
      AUTH_CHALLENGE_CLEANUP_BATCH_SIZE: 2,
      TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: 300,
    } as ApiEnvironment;

    try {
      await new TrustedPrelaunchService(prisma, redis, environment).issue(
        'clock-skew-test',
      );

      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          createdAt: databaseNow,
          expiresAt: new Date('2026-08-13T10:05:00.000Z'),
        }),
      });
      expect(findMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: databaseNow } },
        select: { id: true },
        orderBy: { expiresAt: 'asc' },
        take: 2,
      });
      expect(deleteMany).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
