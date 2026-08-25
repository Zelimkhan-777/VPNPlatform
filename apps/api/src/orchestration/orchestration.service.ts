import { Inject, Injectable } from '@nestjs/common';
import { NodeSyncJobStatus, type Prisma } from '@prisma/client';
import { nodeSyncRequestedEventSchema } from '@vpn-platform/contracts';
import { PrismaService } from '../database/prisma.service';
import {
  DeviceAccessRevoker,
  type RevokeDeviceAccessResult,
} from './device-access-revoker.service';
import {
  NodeAccessGrantScheduler,
  type ScheduleNodeAccessGrantInput,
  type ScheduleNodeAccessGrantResult,
} from './node-access-grant-scheduler.service';
import {
  NodeLifecycleManager,
  type DisableNodeResult,
  type QuarantineNodeInput,
  type QuarantineNodeResult,
} from './node-lifecycle-manager.service';

export type {
  ScheduleNodeAccessGrantInput,
  ScheduleNodeAccessGrantResult,
} from './node-access-grant-scheduler.service';

export type { RevokeDeviceAccessResult } from './device-access-revoker.service';

export type {
  DisableNodeResult,
  QuarantineNodeInput,
  QuarantineNodeResult,
} from './node-lifecycle-manager.service';

export type AcknowledgeNodeConfigInput = {
  nodeId: string;
  nodeSyncJobId: string;
  targetVersion: number;
  snapshotHash: string;
};

export type AcknowledgeNodeConfigResult = {
  nodeId: string;
  nodeSyncJobId: string;
  appliedConfigVersion: number;
};

export type PublishConnectionRouteInput = {
  nodeId: string;
  endpointId: string;
  connectionProfileId: string;
  syncJobIdempotencyKey: string;
  outboxEventIdempotencyKey: string;
  actorUserId?: string;
};

export type PublishConnectionRouteResult = {
  nodeSyncJobId: string;
  outboxEventId: string;
  activationVersion: number;
};

@Injectable()
export class OrchestrationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NodeAccessGrantScheduler)
    private readonly nodeAccessGrantScheduler: NodeAccessGrantScheduler,
    @Inject(NodeLifecycleManager)
    private readonly nodeLifecycleManager: NodeLifecycleManager,
    @Inject(DeviceAccessRevoker)
    private readonly deviceAccessRevoker: DeviceAccessRevoker,
  ) {}

  async scheduleNodeAccessGrant(
    input: ScheduleNodeAccessGrantInput,
  ): Promise<ScheduleNodeAccessGrantResult> {
    return this.nodeAccessGrantScheduler.schedule(input);
  }

  async publishConnectionRoute(
    input: PublishConnectionRouteInput,
  ): Promise<PublishConnectionRouteResult> {
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
        }),
        transaction.outboxEvent.findUnique({
          where: { idempotencyKey: input.outboxEventIdempotencyKey },
        }),
      ]);
      if (existingSyncJob || existingOutboxEvent) {
        const existingPayload = nodeSyncRequestedEventSchema.safeParse(
          existingOutboxEvent?.payload,
        );
        if (
          !existingSyncJob ||
          existingSyncJob.nodeId !== input.nodeId ||
          existingSyncJob.routeEndpointId !== input.endpointId ||
          existingSyncJob.routeConnectionProfileId !==
            input.connectionProfileId ||
          !existingOutboxEvent ||
          existingOutboxEvent.topic !== 'node-sync.requested' ||
          existingOutboxEvent.aggregateType !== 'ConnectionRoute' ||
          existingOutboxEvent.aggregateId !== input.endpointId ||
          !existingPayload.success ||
          !('routeEndpointId' in existingPayload.data) ||
          existingPayload.data.routeEndpointId !== input.endpointId ||
          existingPayload.data.routeConnectionProfileId !==
            input.connectionProfileId ||
          existingPayload.data.nodeSyncJobId !== existingSyncJob.id ||
          existingPayload.data.targetVersion !== existingSyncJob.targetVersion
        ) {
          throw new Error('Idempotency key does not match the requested route');
        }
        return {
          nodeSyncJobId: existingSyncJob.id,
          outboxEventId: existingOutboxEvent.id,
          activationVersion: existingSyncJob.targetVersion,
        };
      }

      const nodes = await transaction.$queryRaw<
        {
          id: string;
          desiredConfigVersion: number;
          status: 'HEALTHY' | 'DRAINING' | 'DISABLED';
        }[]
      >`
        SELECT "id", "desiredConfigVersion", "status"::text AS "status"
        FROM "Node"
        WHERE "id" = CAST(${input.nodeId} AS uuid)
        FOR UPDATE
      `;
      const node = nodes[0];
      if (!node) throw new Error('Connection route requires an existing node');
      if (node.status !== 'HEALTHY') {
        throw new Error('Connection route requires a healthy node');
      }

      const endpoints = await transaction.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "Endpoint"
        WHERE "id" = CAST(${input.endpointId} AS uuid)
          AND "nodeId" = CAST(${input.nodeId} AS uuid)
        FOR UPDATE
      `;
      if (!endpoints[0]) {
        throw new Error('Connection route endpoint does not belong to node');
      }

      const profiles = await transaction.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "ConnectionProfile"
        WHERE "id" = CAST(${input.connectionProfileId} AS uuid)
          AND "nodeId" = CAST(${input.nodeId} AS uuid)
        FOR UPDATE
      `;
      if (!profiles[0]) {
        throw new Error('Connection route profile does not belong to node');
      }

      const publicConfigs = await transaction.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "VlessTcpTlsPublicConfig"
        WHERE "connectionProfileId" =
          CAST(${input.connectionProfileId} AS uuid)
        FOR UPDATE
      `;
      if (!publicConfigs[0]) {
        throw new Error('Connection route public config is unavailable');
      }

      const lockedRoutes = await transaction.$queryRaw<
        { endpointId: string }[]
      >`
        SELECT "endpointId"
        FROM "EndpointConnectionProfile"
        WHERE "endpointId" = CAST(${input.endpointId} AS uuid)
          AND "connectionProfileId" =
            CAST(${input.connectionProfileId} AS uuid)
          AND "nodeId" = CAST(${input.nodeId} AS uuid)
        FOR UPDATE
      `;
      if (!lockedRoutes[0]) {
        await transaction.endpointConnectionProfile.create({
          data: {
            endpointId: input.endpointId,
            connectionProfileId: input.connectionProfileId,
            nodeId: input.nodeId,
          },
        });
      }

      const activationVersion = node.desiredConfigVersion + 1;
      await transaction.endpoint.update({
        where: { id: input.endpointId },
        data: { status: 'ACTIVE' },
      });
      await transaction.connectionProfile.update({
        where: { id: input.connectionProfileId },
        data: { status: 'ACTIVE' },
      });
      await transaction.node.update({
        where: { id: input.nodeId },
        data: { desiredConfigVersion: activationVersion },
      });
      const syncJob = await transaction.nodeSyncJob.create({
        data: {
          nodeId: input.nodeId,
          routeEndpointId: input.endpointId,
          routeConnectionProfileId: input.connectionProfileId,
          targetVersion: activationVersion,
          idempotencyKey: input.syncJobIdempotencyKey,
        },
      });
      const outboxEvent = await transaction.outboxEvent.create({
        data: {
          topic: 'node-sync.requested',
          aggregateType: 'ConnectionRoute',
          aggregateId: input.endpointId,
          payload: {
            routeEndpointId: input.endpointId,
            routeConnectionProfileId: input.connectionProfileId,
            nodeSyncJobId: syncJob.id,
            targetVersion: activationVersion,
          },
          idempotencyKey: input.outboxEventIdempotencyKey,
        },
      });
      await transaction.endpointConnectionProfile.update({
        where: {
          endpointId_connectionProfileId: {
            endpointId: input.endpointId,
            connectionProfileId: input.connectionProfileId,
          },
        },
        data: { activationVersion },
      });
      await transaction.auditEvent.create({
        data: {
          ...(input.actorUserId === undefined
            ? {}
            : { actorUserId: input.actorUserId }),
          action: 'connection-route.published',
          entityType: 'ConnectionRoute',
          entityId: input.endpointId,
          metadata: {
            nodeId: input.nodeId,
            connectionProfileId: input.connectionProfileId,
            nodeSyncJobId: syncJob.id,
            activationVersion,
          },
        },
      });

      return {
        nodeSyncJobId: syncJob.id,
        outboxEventId: outboxEvent.id,
        activationVersion,
      };
    });
  }

  async disableNode(
    nodeId: string,
    actorUserId?: string,
  ): Promise<DisableNodeResult> {
    return this.nodeLifecycleManager.disable(nodeId, actorUserId);
  }

  async quarantineNode(
    input: QuarantineNodeInput,
  ): Promise<QuarantineNodeResult> {
    return this.nodeLifecycleManager.quarantine(input);
  }

  async revokeDeviceAccess(
    userId: string,
    deviceId: string,
  ): Promise<RevokeDeviceAccessResult> {
    return this.deviceAccessRevoker.revoke(userId, deviceId);
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
        select: {
          nodeId: true,
          nodeSyncJobId: true,
          targetVersion: true,
          snapshotHash: true,
        },
      });
    if (existingAcknowledgement) {
      if (
        existingAcknowledgement.nodeId !== input.nodeId ||
        existingAcknowledgement.targetVersion !== input.targetVersion ||
        existingAcknowledgement.snapshotHash !== input.snapshotHash
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
        configDeliveries: {
          some: {
            nodeId: input.nodeId,
            targetVersion: input.targetVersion,
            snapshotHash: input.snapshotHash,
          },
        },
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
        snapshotHash: input.snapshotHash,
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
          snapshotHash: input.snapshotHash,
        },
      },
    });

    return {
      nodeId: input.nodeId,
      nodeSyncJobId: input.nodeSyncJobId,
      appliedConfigVersion: node.appliedConfigVersion,
    };
  }
}
