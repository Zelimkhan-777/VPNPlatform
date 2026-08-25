import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../database/prisma.service';
import {
  DATA_PLANE_CREDENTIAL_DERIVATION_VERSION,
  DataPlaneCredentialService,
} from './data-plane-credential.service';
import { isNodeEligibleForNewAssignment } from './node-access-control';

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

@Injectable()
export class NodeAccessGrantScheduler {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DataPlaneCredentialService)
    private readonly dataPlaneCredentials?: DataPlaneCredentialService,
  ) {}

  async schedule(
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

      const nodes = await transaction.$queryRaw<
        { id: string; status: string }[]
      >`
        SELECT "id", "status"::text AS "status"
        FROM "Node"
        WHERE "id" = CAST(${input.nodeId} AS uuid)
        FOR UPDATE
      `;
      const assignedNode = nodes[0];
      if (!assignedNode) {
        throw new Error('Node access cannot be scheduled for this node');
      }
      if (!isNodeEligibleForNewAssignment(assignedNode.status)) {
        throw new Error('Node access cannot be scheduled for this node');
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
}
