import { NodeSyncJobStatus, OutboxEventStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { OrchestrationService } from './orchestration.service';

const policy = {
  ORCHESTRATION_LEASE_DURATION_MS: 30_000,
  ORCHESTRATION_MAX_ATTEMPTS: 3,
} as never;

function createService(
  prisma: unknown,
  nodeAccessGrantScheduler: unknown = { schedule: vi.fn() },
) {
  return new OrchestrationService(
    prisma as never,
    policy,
    nodeAccessGrantScheduler as never,
  );
}

describe('OrchestrationService', () => {
  it('delegates grant scheduling without changing the input or result', async () => {
    const input = {
      nodeId: 'node-1',
      deviceId: 'device-1',
      expiresAt: new Date('2026-08-26T00:00:00.000Z'),
      syncJobIdempotencyKey: 'sync-1',
      outboxEventIdempotencyKey: 'outbox-1',
      actorUserId: 'user-1',
    };
    const result = {
      nodeAccessGrantId: 'grant-1',
      nodeSyncJobId: 'job-1',
      outboxEventId: 'event-1',
      targetVersion: 3,
    };
    const scheduler = { schedule: vi.fn().mockResolvedValue(result) };
    const service = createService({}, scheduler);

    await expect(service.scheduleNodeAccessGrant(input)).resolves.toBe(result);
    expect(scheduler.schedule).toHaveBeenCalledOnce();
    expect(scheduler.schedule).toHaveBeenCalledWith(input);
  });

  it('returns expired processing leases to pending work', async () => {
    const nodeSyncUpdate = { kind: 'node-sync-update' };
    const outboxUpdate = { kind: 'outbox-update' };
    const prisma = {
      nodeSyncJob: { updateMany: vi.fn(() => nodeSyncUpdate) },
      outboxEvent: { updateMany: vi.fn(() => outboxUpdate) },
      $transaction: vi.fn().mockResolvedValue([{ count: 2 }, { count: 3 }]),
    };
    const service = createService(prisma);
    const now = new Date('2026-08-10T14:00:00.000Z');

    await expect(service.reclaimExpiredLeases(now)).resolves.toEqual({
      nodeSyncJobs: 2,
      outboxEvents: 3,
    });

    expect(prisma.nodeSyncJob.updateMany).toHaveBeenCalledWith({
      where: {
        status: NodeSyncJobStatus.PROCESSING,
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: NodeSyncJobStatus.PENDING,
        nextAttemptAt: now,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        status: OutboxEventStatus.PROCESSING,
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: OutboxEventStatus.PENDING,
        nextAttemptAt: now,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
  });

  it('claims an eligible job exactly once', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      nodeSyncJob: { updateMany },
      outboxEvent: {},
      $transaction: vi.fn(),
    };
    const service = createService(prisma);
    const now = new Date('2026-08-10T14:00:00.000Z');

    await expect(
      service.claimNodeSyncJob('job-1', 'worker-a', now),
    ).resolves.toEqual(expect.any(String));
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        status: NodeSyncJobStatus.PENDING,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      data: {
        status: NodeSyncJobStatus.PROCESSING,
        attempts: { increment: 1 },
        nextAttemptAt: null,
        leaseOwner: 'worker-a',
        leaseToken: expect.any(String),
        leaseExpiresAt: new Date('2026-08-10T14:00:30.000Z'),
      },
    });
  });

  it('completes only the worker-owned unexpired lease', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = createService({
      nodeSyncJob: { updateMany },
    });
    const now = new Date('2026-08-10T14:00:00.000Z');

    await expect(
      service.completeNodeSyncJob('job-1', 'worker-a', 'lease-token', now),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          leaseOwner: 'worker-a',
          leaseExpiresAt: { gt: now },
        }),
        data: expect.objectContaining({
          status: NodeSyncJobStatus.SUCCEEDED,
          completedAt: now,
          leaseOwner: null,
        }),
      }),
    );
  });

  it('claims and publishes an outbox event under its lease', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = createService({
      outboxEvent: { updateMany },
    });
    const now = new Date('2026-08-10T14:00:00.000Z');

    await expect(
      service.claimOutboxEvent('event-1', 'worker-a', now),
    ).resolves.toEqual(expect.any(String));
    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ nextAttemptAt: null }),
      }),
    );
    await expect(
      service.publishOutboxEvent('event-1', 'worker-a', 'lease-token', now),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: OutboxEventStatus.PROCESSING,
          leaseOwner: 'worker-a',
        }),
        data: expect.objectContaining({
          status: OutboxEventStatus.PUBLISHED,
          publishedAt: now,
          leaseOwner: null,
        }),
      }),
    );
  });

  it('fails an outbox event after its retry limit', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = createService({
      outboxEvent: {
        findFirst: vi.fn().mockResolvedValue({ attempts: 3 }),
        updateMany,
      },
    });
    const now = new Date('2026-08-10T14:00:00.000Z');

    await expect(
      service.retryOutboxEvent(
        'event-1',
        'worker-a',
        'lease-token',
        new Date('2026-08-10T14:01:00.000Z'),
        'NETWORK_ERROR',
        now,
      ),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: OutboxEventStatus.FAILED,
          lastErrorCode: 'NETWORK_ERROR',
          leaseOwner: null,
        }),
      }),
    );
  });
});
