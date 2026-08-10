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
});
