import { NodeSyncJobStatus, OutboxEventStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { OrchestrationService } from './orchestration.service';

describe('OrchestrationService', () => {
  it('returns expired processing leases to pending work', async () => {
    const nodeSyncUpdate = { kind: 'node-sync-update' };
    const outboxUpdate = { kind: 'outbox-update' };
    const prisma = {
      nodeSyncJob: { updateMany: vi.fn(() => nodeSyncUpdate) },
      outboxEvent: { updateMany: vi.fn(() => outboxUpdate) },
      $transaction: vi.fn().mockResolvedValue([{ count: 2 }, { count: 3 }]),
    };
    const service = new OrchestrationService(prisma as never);
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
    const service = new OrchestrationService(prisma as never);
    const now = new Date('2026-08-10T14:00:00.000Z');
    const leaseExpiresAt = new Date('2026-08-10T14:00:30.000Z');

    await expect(
      service.claimNodeSyncJob('job-1', 'worker-a', leaseExpiresAt, now),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        status: NodeSyncJobStatus.PENDING,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      data: {
        status: NodeSyncJobStatus.PROCESSING,
        attempts: { increment: 1 },
        leaseOwner: 'worker-a',
        leaseExpiresAt,
      },
    });
  });

  it('completes only the worker-owned unexpired lease', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new OrchestrationService({
      nodeSyncJob: { updateMany },
    } as never);
    const now = new Date('2026-08-10T14:00:00.000Z');

    await expect(
      service.completeNodeSyncJob('job-1', 'worker-a', now),
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
    const service = new OrchestrationService({
      outboxEvent: { updateMany },
    } as never);
    const now = new Date('2026-08-10T14:00:00.000Z');
    const expiresAt = new Date('2026-08-10T14:00:30.000Z');

    await expect(
      service.claimOutboxEvent('event-1', 'worker-a', expiresAt, now),
    ).resolves.toBe(true);
    await expect(
      service.publishOutboxEvent('event-1', 'worker-a', now),
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
});
