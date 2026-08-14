import { Inject, Injectable } from '@nestjs/common';
import {
  NodeSyncJobStatus,
  OutboxEventStatus,
  type Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../database/prisma.service';
import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import {
  DATA_PLANE_CREDENTIAL_DERIVATION_VERSION,
  DataPlaneCredentialService,
} from './data-plane-credential.service';

export type ScheduleNodeAccessGrantInput = {
  nodeId: string;
  deviceId: string;
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

export type AcknowledgeNodeConfigInput = {
  nodeId: string;
  nodeSyncJobId: string;
  targetVersion: number;
};

export type AcknowledgeNodeConfigResult = {
  nodeId: string;
  nodeSyncJobId: string;
  appliedConfigVersion: number;
};

export type RevokeDeviceAccessResult =
  'revoked' | 'already-revoked' | 'not-found';

@Injectable()
export class OrchestrationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
    @Inject(DataPlaneCredentialService)
    private readonly dataPlaneCredentials?: DataPlaneCredentialService,
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

      const devices = await transaction.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "Device"
        WHERE "id" = CAST(${input.deviceId} AS uuid)
          AND "status" = CAST('ACTIVE' AS "DeviceStatus")
        FOR UPDATE
      `;
      if (!devices[0]) {
        throw new Error('Node access cannot be scheduled for this device');
      }

      const node = await transaction.node.update({
        where: { id: input.nodeId },
        data: { desiredConfigVersion: { increment: 1 } },
        select: { desiredConfigVersion: true },
      });
      const grantId = randomUUID();
      if (!this.dataPlaneCredentials) {
        throw new Error('Data-plane credential provider is unavailable');
      }
      const dataPlaneCredential = this.dataPlaneCredentials.derive({
        grantId,
        deviceId: input.deviceId,
        nodeId: input.nodeId,
      });
      const grant = await transaction.nodeAccessGrant.create({
        data: {
          id: grantId,
          nodeId: input.nodeId,
          deviceId: input.deviceId,
          dataPlaneCredentialHash:
            this.dataPlaneCredentials.hash(dataPlaneCredential),
          dataPlaneCredentialDerivationVersion:
            DATA_PLANE_CREDENTIAL_DERIVATION_VERSION,
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

  async revokeDeviceAccess(
    userId: string,
    deviceId: string,
  ): Promise<RevokeDeviceAccessResult> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`cabinet-device:${userId}`}))
      `;
      const devices = await transaction.$queryRaw<
        { id: string; status: 'ACTIVE' | 'REVOKED' }[]
      >`
        SELECT "id", "status"
        FROM "Device"
        WHERE "id" = CAST(${deviceId} AS uuid)
          AND "userId" = CAST(${userId} AS uuid)
        FOR UPDATE
      `;
      const device = devices[0];
      if (!device) return 'not-found';
      if (device.status === 'REVOKED') return 'already-revoked';

      await transaction.$queryRaw`
        SELECT node."id"
        FROM "Node" AS node
        INNER JOIN "NodeAccessGrant" AS access_grant
          ON access_grant."nodeId" = node."id"
        WHERE access_grant."deviceId" = CAST(${deviceId} AS uuid)
          AND access_grant."status" <> CAST('REVOKED' AS "NodeAccessGrantStatus")
        ORDER BY node."id"
        FOR UPDATE OF node
      `;
      await transaction.$queryRaw`
        SELECT "id"
        FROM "NodeAccessGrant"
        WHERE "deviceId" = CAST(${deviceId} AS uuid)
          AND "status" <> CAST('REVOKED' AS "NodeAccessGrantStatus")
        ORDER BY "nodeId", "id"
        FOR UPDATE
      `;
      const databaseTime = await transaction.$queryRaw<{ now: Date }[]>`
        SELECT clock_timestamp() AS "now"
      `;
      const now = databaseTime[0]?.now;
      if (!now) throw new Error('PostgreSQL clock is unavailable');
      const grants = await transaction.nodeAccessGrant.findMany({
        where: { deviceId, status: { not: 'REVOKED' } },
        orderBy: [{ nodeId: 'asc' }, { id: 'asc' }],
        select: { id: true, nodeId: true },
      });

      await transaction.device.update({
        where: { id: deviceId },
        data: { status: 'REVOKED', revokedAt: now },
      });
      for (const grant of grants) {
        const node = await transaction.node.update({
          where: { id: grant.nodeId },
          data: { desiredConfigVersion: { increment: 1 } },
          select: { desiredConfigVersion: true },
        });
        await transaction.nodeAccessGrant.update({
          where: { id: grant.id },
          data: {
            status: 'REVOKED',
            revokedAt: now,
            desiredVersion: node.desiredConfigVersion,
          },
        });
        const syncJob = await transaction.nodeSyncJob.create({
          data: {
            nodeId: grant.nodeId,
            nodeAccessGrantId: grant.id,
            targetVersion: node.desiredConfigVersion,
            idempotencyKey: `device-revoke:${deviceId}:${grant.id}:${node.desiredConfigVersion}`,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            topic: 'node-sync.requested',
            aggregateType: 'NodeAccessGrant',
            aggregateId: grant.id,
            payload: {
              nodeAccessGrantId: grant.id,
              nodeSyncJobId: syncJob.id,
              targetVersion: node.desiredConfigVersion,
            },
            idempotencyKey: `device-revoke-outbox:${grant.id}:${node.desiredConfigVersion}`,
          },
        });
        await transaction.auditEvent.create({
          data: {
            actorUserId: userId,
            action: 'node-access-grant.revoked',
            entityType: 'NodeAccessGrant',
            entityId: grant.id,
            metadata: {
              nodeId: grant.nodeId,
              nodeSyncJobId: syncJob.id,
              targetVersion: node.desiredConfigVersion,
            },
          },
        });
      }
      await transaction.auditEvent.create({
        data: {
          actorUserId: userId,
          action: 'device.revoked',
          entityType: 'Device',
          entityId: deviceId,
          metadata: { revokedGrantCount: grants.length },
        },
      });
      return 'revoked';
    });
  }

  async acknowledgeNodeConfig(
    input: AcknowledgeNodeConfigInput,
    now = new Date(),
  ): Promise<AcknowledgeNodeConfigResult> {
    return this.prisma.$transaction((transaction) =>
      this.acknowledgeNodeConfigInTransaction(transaction, input, now),
    );
  }

  async acknowledgeNodeConfigInTransaction(
    transaction: Prisma.TransactionClient,
    input: AcknowledgeNodeConfigInput,
    now = new Date(),
  ): Promise<AcknowledgeNodeConfigResult> {
    await transaction.$queryRaw`
      SELECT "id"
      FROM "Node"
      WHERE "id" = CAST(${input.nodeId} AS uuid)
      FOR UPDATE
    `;
    await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`node-config:${input.nodeId}`}))
      `;

    const existingAcknowledgement =
      await transaction.nodeConfigAcknowledgement.findUnique({
        where: { nodeSyncJobId: input.nodeSyncJobId },
        select: { nodeId: true, nodeSyncJobId: true, targetVersion: true },
      });
    if (existingAcknowledgement) {
      if (
        existingAcknowledgement.nodeId !== input.nodeId ||
        existingAcknowledgement.targetVersion !== input.targetVersion
      ) {
        throw new Error(
          'Node sync job does not match the requested acknowledgement',
        );
      }
      const node = await transaction.node.findUniqueOrThrow({
        where: { id: input.nodeId },
        select: { appliedConfigVersion: true },
      });
      await transaction.$executeRaw`
          UPDATE "NodeAccessGrant"
          SET "appliedVersion" = "desiredVersion", "updatedAt" = ${now}
          WHERE "nodeId" = CAST(${input.nodeId} AS uuid)
            AND "desiredVersion" <= ${input.targetVersion}
            AND "appliedVersion" < "desiredVersion"
        `;
      return {
        nodeId: input.nodeId,
        nodeSyncJobId: input.nodeSyncJobId,
        appliedConfigVersion: node.appliedConfigVersion,
      };
    }

    const syncJob = await transaction.nodeSyncJob.findFirst({
      where: {
        id: input.nodeSyncJobId,
        nodeId: input.nodeId,
        targetVersion: input.targetVersion,
        status: NodeSyncJobStatus.SUCCEEDED,
      },
      select: { id: true },
    });
    if (!syncJob) {
      throw new Error('Node sync job is not eligible for acknowledgement');
    }

    const currentNode = await transaction.node.findUniqueOrThrow({
      where: { id: input.nodeId },
      select: { appliedConfigVersion: true },
    });
    await transaction.nodeConfigAcknowledgement.create({
      data: {
        nodeId: input.nodeId,
        nodeSyncJobId: syncJob.id,
        targetVersion: input.targetVersion,
        acknowledgedAt: now,
      },
    });
    const node =
      input.targetVersion > currentNode.appliedConfigVersion
        ? await transaction.node.update({
            where: { id: input.nodeId },
            data: { appliedConfigVersion: input.targetVersion },
            select: { appliedConfigVersion: true },
          })
        : currentNode;
    await transaction.$executeRaw`
        UPDATE "NodeAccessGrant"
        SET "appliedVersion" = "desiredVersion", "updatedAt" = ${now}
        WHERE "nodeId" = CAST(${input.nodeId} AS uuid)
          AND "desiredVersion" <= ${input.targetVersion}
          AND "appliedVersion" < "desiredVersion"
      `;
    await transaction.auditEvent.create({
      data: {
        action: 'node-config.acknowledged',
        entityType: 'Node',
        entityId: input.nodeId,
        metadata: {
          nodeSyncJobId: input.nodeSyncJobId,
          targetVersion: input.targetVersion,
        },
      },
    });

    return {
      nodeId: input.nodeId,
      nodeSyncJobId: input.nodeSyncJobId,
      appliedConfigVersion: node.appliedConfigVersion,
    };
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
          leaseToken: null,
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
          leaseToken: null,
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
