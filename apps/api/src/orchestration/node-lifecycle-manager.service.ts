import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';
import { isNodeEligibleForEmergencyQuarantine } from './node-access-control';

export type QuarantineNodeInput = {
  nodeId: string;
  syncJobIdempotencyKey: string;
  outboxEventIdempotencyKey: string;
  actorUserId?: string;
};

export type QuarantineNodeResult = {
  nodeId: string;
  nodeSyncJobId: string | null;
  outboxEventId: string | null;
  targetVersion: number;
};

export type DisableNodeResult = {
  nodeId: string;
  status: 'DISABLED';
};

@Injectable()
export class NodeLifecycleManager {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async disable(
    nodeId: string,
    actorUserId?: string,
  ): Promise<DisableNodeResult> {
    return this.prisma.$transaction(async (transaction) => {
      const nodes = await transaction.$queryRaw<
        { id: string; status: string }[]
      >`
        SELECT "id", "status"::text AS "status"
        FROM "Node"
        WHERE "id" = CAST(${nodeId} AS uuid)
        FOR UPDATE
      `;
      const node = nodes[0];
      if (!node) {
        throw new Error('Node cannot be disabled');
      }
      if (node.status === 'DISABLED') {
        return { nodeId: node.id, status: 'DISABLED' };
      }
      if (node.status !== 'HEALTHY' && node.status !== 'DRAINING') {
        throw new Error('Node cannot be disabled');
      }

      await transaction.node.update({
        where: { id: nodeId },
        data: { status: 'DISABLED' },
      });
      await transaction.auditEvent.create({
        data: {
          ...(actorUserId === undefined ? {} : { actorUserId }),
          action: 'node.disabled',
          entityType: 'Node',
          entityId: nodeId,
          metadata: { previousStatus: node.status },
        },
      });

      return { nodeId: node.id, status: 'DISABLED' };
    });
  }

  async quarantine(input: QuarantineNodeInput): Promise<QuarantineNodeResult> {
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
        const node = existingSyncJob
          ? await transaction.node.findUnique({
              where: { id: existingSyncJob.nodeId },
              select: { status: true },
            })
          : null;
        if (
          !existingSyncJob ||
          existingSyncJob.nodeId !== input.nodeId ||
          !existingSyncJob.nodeAccessGrantId ||
          node?.status !== 'QUARANTINED' ||
          !existingOutboxEvent ||
          existingOutboxEvent.topic !== 'node-sync.requested' ||
          existingOutboxEvent.aggregateType !== 'NodeAccessGrant' ||
          existingOutboxEvent.aggregateId !== existingSyncJob.nodeAccessGrantId
        ) {
          throw new Error(
            'Idempotency key does not match the requested quarantine',
          );
        }
        return {
          nodeId: existingSyncJob.nodeId,
          nodeSyncJobId: existingSyncJob.id,
          outboxEventId: existingOutboxEvent.id,
          targetVersion: existingSyncJob.targetVersion,
        };
      }

      const nodes = await transaction.$queryRaw<
        { id: string; status: string; desiredConfigVersion: number }[]
      >`
        SELECT
          "id",
          "status"::text AS "status",
          "desiredConfigVersion"
        FROM "Node"
        WHERE "id" = CAST(${input.nodeId} AS uuid)
        FOR UPDATE
      `;
      const node = nodes[0];
      if (!node) {
        throw new Error('Node cannot be quarantined');
      }
      if (node.status === 'QUARANTINED') {
        return {
          nodeId: node.id,
          nodeSyncJobId: null,
          outboxEventId: null,
          targetVersion: node.desiredConfigVersion,
        };
      }
      if (!isNodeEligibleForEmergencyQuarantine(node.status)) {
        throw new Error('Node cannot be quarantined');
      }

      await transaction.$queryRaw`
        SELECT "id"
        FROM "NodeAccessGrant"
        WHERE "nodeId" = CAST(${input.nodeId} AS uuid)
          AND "status" <> CAST('REVOKED' AS "NodeAccessGrantStatus")
        ORDER BY "id"
        FOR UPDATE
      `;
      const databaseTime = await transaction.$queryRaw<{ now: Date }[]>`
        SELECT clock_timestamp() AS "now"
      `;
      const now = databaseTime[0]?.now;
      if (!now) throw new Error('PostgreSQL clock is unavailable');
      const grants = await transaction.nodeAccessGrant.findMany({
        where: { nodeId: input.nodeId, status: { not: 'REVOKED' } },
        orderBy: { id: 'asc' },
        select: { id: true },
      });

      let nodeSyncJobId: string | null = null;
      let outboxEventId: string | null = null;
      let targetVersion = node.desiredConfigVersion;
      if (grants.length > 0) {
        const updatedNode = await transaction.node.update({
          where: { id: input.nodeId },
          data: { desiredConfigVersion: { increment: 1 } },
          select: { desiredConfigVersion: true },
        });
        targetVersion = updatedNode.desiredConfigVersion;
        for (const grant of grants) {
          await transaction.nodeAccessGrant.update({
            where: { id: grant.id },
            data: {
              status: 'REVOKED',
              revokedAt: now,
              desiredVersion: targetVersion,
            },
          });
        }
        const leadGrant = grants[0];
        if (!leadGrant) {
          throw new Error('Quarantine revoke-all requires a live grant');
        }
        const syncJob = await transaction.nodeSyncJob.create({
          data: {
            nodeId: input.nodeId,
            nodeAccessGrantId: leadGrant.id,
            targetVersion,
            idempotencyKey: input.syncJobIdempotencyKey,
          },
        });
        const outboxEvent = await transaction.outboxEvent.create({
          data: {
            topic: 'node-sync.requested',
            aggregateType: 'NodeAccessGrant',
            aggregateId: leadGrant.id,
            payload: {
              nodeAccessGrantId: leadGrant.id,
              nodeSyncJobId: syncJob.id,
              targetVersion,
            },
            idempotencyKey: input.outboxEventIdempotencyKey,
          },
        });
        nodeSyncJobId = syncJob.id;
        outboxEventId = outboxEvent.id;
      }

      await transaction.node.update({
        where: { id: input.nodeId },
        data: { status: 'QUARANTINED' },
      });
      await transaction.auditEvent.create({
        data: {
          ...(input.actorUserId === undefined
            ? {}
            : { actorUserId: input.actorUserId }),
          action: 'node.quarantined',
          entityType: 'Node',
          entityId: input.nodeId,
          metadata: {
            nodeSyncJobId,
            targetVersion,
            revokedGrantCount: grants.length,
          },
        },
      });

      return {
        nodeId: input.nodeId,
        nodeSyncJobId,
        outboxEventId,
        targetVersion,
      };
    });
  }
}
