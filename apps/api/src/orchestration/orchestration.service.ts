import { Inject, Injectable } from '@nestjs/common';
import { NodeSyncJobStatus, OutboxEventStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../database/prisma.service';
import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';

export type ScheduleNodeAccessGrantInput = {
  nodeId: string;
  deviceId: string;
  dataPlaneCredentialHash: string;
  expiresAt: Date;
  syncJobIdempotencyKey: string;
  outboxEventIdempotencyKey: string;
  actorUserId?: string;
};

export type ScheduleNodeAccessGrantResult = {
  nodeAccessGrantId: string;
  nodeSyncJobId: string;
  outboxEventId: string;
  targetVersion: number;
};

@Injectable()
export class OrchestrationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  async scheduleNodeAccessGrant(
    input: ScheduleNodeAccessGrantInput,
  ): Promise<ScheduleNodeAccessGrantResult> {
    return this.prisma.$transaction(async (transaction) => {
      const advisoryLockKeys = [
        `node-sync-job:${input.syncJobIdempotencyKey}`,
        `outbox-event:${input.outboxEventIdempotencyKey}`,
      ].sort();
      for (const advisoryLockKey of advisoryLockKeys) {
        await transaction.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(${advisoryLockKey}))
        `;
      }

      const [existingSyncJob, existingOutboxEvent] = await Promise.all([
        transaction.nodeSyncJob.findUnique({
          where: { idempotencyKey: input.syncJobIdempotencyKey },
          include: { nodeAccessGrant: true },
        }),
        transaction.outboxEvent.findUnique({
          where: { idempotencyKey: input.outboxEventIdempotencyKey },
        }),
      ]);
      if (existingSyncJob || existingOutboxEvent) {
        if (
          !existingSyncJob ||
          existingSyncJob.nodeId !== input.nodeId ||
          existingSyncJob.nodeAccessGrant?.deviceId !== input.deviceId ||
          !existingSyncJob.nodeAccessGrantId ||
          !existingOutboxEvent ||
          existingOutboxEvent.aggregateId !== existingSyncJob.nodeAccessGrantId
        ) {
          throw new Error('Idempotency key does not match the requested grant');
        }
        return {
          nodeAccessGrantId: existingSyncJob.nodeAccessGrantId,
          nodeSyncJobId: existingSyncJob.id,
          outboxEventId: existingOutboxEvent.id,
          targetVersion: existingSyncJob.targetVersion,
        };
      }

      const node = await transaction.node.update({
        where: { id: input.nodeId },
        data: { desiredConfigVersion: { increment: 1 } },
        select: { desiredConfigVersion: true },
      });
      const grant = await transaction.nodeAccessGrant.create({
        data: {
          nodeId: input.nodeId,
          deviceId: input.deviceId,
          dataPlaneCredentialHash: input.dataPlaneCredentialHash,
          expiresAt: input.expiresAt,
          desiredVersion: node.desiredConfigVersion,
        },
      });
      const syncJob = await transaction.nodeSyncJob.create({
        data: {
          nodeId: input.nodeId,
          nodeAccessGrantId: grant.id,
          targetVersion: node.desiredConfigVersion,
          idempotencyKey: input.syncJobIdempotencyKey,
        },
      });
      const outboxEvent = await transaction.outboxEvent.create({
        data: {
          topic: 'node-sync.requested',
          aggregateType: 'NodeAccessGrant',
          aggregateId: grant.id,
          payload: {
            nodeAccessGrantId: grant.id,
            nodeSyncJobId: syncJob.id,
            targetVersion: node.desiredConfigVersion,
          },
          idempotencyKey: input.outboxEventIdempotencyKey,
        },
      });
      await transaction.auditEvent.create({
        data: {
          ...(input.actorUserId === undefined
            ? {}
            : { actorUserId: input.actorUserId }),
          action: 'node-access-grant.scheduled',
          entityType: 'NodeAccessGrant',
          entityId: grant.id,
          metadata: {
            nodeId: input.nodeId,
            nodeSyncJobId: syncJob.id,
            targetVersion: node.desiredConfigVersion,
          },
        },
      });

      return {
        nodeAccessGrantId: grant.id,
        nodeSyncJobId: syncJob.id,
        outboxEventId: outboxEvent.id,
        targetVersion: node.desiredConfigVersion,
      };
    });
  }

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

  async claimNodeSyncJob(
    id: string,
    leaseOwner: string,
    now = new Date(),
  ): Promise<string | null> {
    const leaseToken = randomUUID();
    const result = await this.prisma.nodeSyncJob.updateMany({
      where: {
        id,
        status: NodeSyncJobStatus.PENDING,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      data: {
        status: NodeSyncJobStatus.PROCESSING,
        attempts: { increment: 1 },
        nextAttemptAt: null,
        leaseOwner,
        leaseToken,
        leaseExpiresAt: new Date(
          now.getTime() + this.environment.ORCHESTRATION_LEASE_DURATION_MS,
        ),
      },
    });

    return result.count === 1 ? leaseToken : null;
  }

  async completeNodeSyncJob(
    id: string,
    leaseOwner: string,
    leaseToken: string,
    now = new Date(),
  ): Promise<boolean> {
    const result = await this.prisma.nodeSyncJob.updateMany({
      where: {
        id,
        status: NodeSyncJobStatus.PROCESSING,
        leaseOwner,
        leaseToken,
        leaseExpiresAt: { gt: now },
      },
      data: {
        status: NodeSyncJobStatus.SUCCEEDED,
        completedAt: now,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    return result.count === 1;
  }

  async retryNodeSyncJob(
    id: string,
    leaseOwner: string,
    leaseToken: string,
    nextAttemptAt: Date,
    errorCode: string,
    now = new Date(),
  ): Promise<boolean> {
    const job = await this.prisma.nodeSyncJob.findFirst({
      where: {
        id,
        status: NodeSyncJobStatus.PROCESSING,
        leaseOwner,
        leaseToken,
      },
      select: { attempts: true },
    });
    if (!job) return false;

    const exhausted =
      job.attempts >= this.environment.ORCHESTRATION_MAX_ATTEMPTS;
    const result = await this.prisma.nodeSyncJob.updateMany({
      where: {
        id,
        status: NodeSyncJobStatus.PROCESSING,
        leaseOwner,
        leaseToken,
        leaseExpiresAt: { gt: now },
      },
      data: exhausted
        ? {
            status: NodeSyncJobStatus.FAILED,
            lastErrorCode: errorCode,
            completedAt: now,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
          }
        : {
            status: NodeSyncJobStatus.PENDING,
            lastErrorCode: errorCode,
            nextAttemptAt,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
          },
    });
    return result.count === 1;
  }

  async claimOutboxEvent(
    id: string,
    leaseOwner: string,
    now = new Date(),
  ): Promise<string | null> {
    const leaseToken = randomUUID();
    const result = await this.prisma.outboxEvent.updateMany({
      where: {
        id,
        status: OutboxEventStatus.PENDING,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      data: {
        status: OutboxEventStatus.PROCESSING,
        attempts: { increment: 1 },
        nextAttemptAt: null,
        leaseOwner,
        leaseToken,
        leaseExpiresAt: new Date(
          now.getTime() + this.environment.ORCHESTRATION_LEASE_DURATION_MS,
        ),
      },
    });
    return result.count === 1 ? leaseToken : null;
  }

  async publishOutboxEvent(
    id: string,
    leaseOwner: string,
    leaseToken: string,
    now = new Date(),
  ): Promise<boolean> {
    const result = await this.prisma.outboxEvent.updateMany({
      where: {
        id,
        status: OutboxEventStatus.PROCESSING,
        leaseOwner,
        leaseToken,
        leaseExpiresAt: { gt: now },
      },
      data: {
        status: OutboxEventStatus.PUBLISHED,
        publishedAt: now,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    return result.count === 1;
  }

  async retryOutboxEvent(
    id: string,
    leaseOwner: string,
    leaseToken: string,
    nextAttemptAt: Date,
    errorCode: string,
    now = new Date(),
  ): Promise<boolean> {
    const event = await this.prisma.outboxEvent.findFirst({
      where: {
        id,
        status: OutboxEventStatus.PROCESSING,
        leaseOwner,
        leaseToken,
      },
      select: { attempts: true },
    });
    if (!event) return false;

    const result = await this.prisma.outboxEvent.updateMany({
      where: {
        id,
        status: OutboxEventStatus.PROCESSING,
        leaseOwner,
        leaseToken,
        leaseExpiresAt: { gt: now },
      },
      data:
        event.attempts >= this.environment.ORCHESTRATION_MAX_ATTEMPTS
          ? {
              status: OutboxEventStatus.FAILED,
              lastErrorCode: errorCode,
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
            }
          : {
              status: OutboxEventStatus.PENDING,
              lastErrorCode: errorCode,
              nextAttemptAt,
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
            },
    });
    return result.count === 1;
  }
}
