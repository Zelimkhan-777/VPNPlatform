import { Injectable } from '@nestjs/common';
import { NodeSyncJobStatus, OutboxEventStatus } from '@prisma/client';

import type { PrismaService } from '../database/prisma.service';

@Injectable()
export class OrchestrationService {
  constructor(private readonly prisma: PrismaService) {}

  async reclaimExpiredLeases(
    now = new Date(),
  ): Promise<{ nodeSyncJobs: number; outboxEvents: number }> {
    const [nodeSyncJobs, outboxEvents] = await this.prisma.$transaction([
      this.prisma.nodeSyncJob.updateMany({
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
      }),
      this.prisma.outboxEvent.updateMany({
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
      }),
    ]);
    return {
      nodeSyncJobs: nodeSyncJobs.count,
      outboxEvents: outboxEvents.count,
    };
  }
}
