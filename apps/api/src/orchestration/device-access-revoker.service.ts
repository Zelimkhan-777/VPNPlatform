import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';
import { isNodeInAccessControlSync } from './node-access-control';

export type RevokeDeviceAccessResult =
  'revoked' | 'already-revoked' | 'not-found';

@Injectable()
export class DeviceAccessRevoker {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async revoke(
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

      const lockedNodes = await transaction.$queryRaw<
        { id: string; status: string }[]
      >`
        SELECT node."id", node."status"::text AS "status"
        FROM "Node" AS node
        INNER JOIN "NodeAccessGrant" AS access_grant
          ON access_grant."nodeId" = node."id"
        WHERE access_grant."deviceId" = CAST(${deviceId} AS uuid)
          AND access_grant."status" <> CAST('REVOKED' AS "NodeAccessGrantStatus")
        ORDER BY node."id"
        FOR UPDATE OF node
      `;
      const nodeStatusById = new Map(
        lockedNodes.map((node) => [node.id, node.status]),
      );
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
        const nodeStatus = nodeStatusById.get(grant.nodeId);
        if (!nodeStatus || !isNodeInAccessControlSync(nodeStatus)) {
          await transaction.nodeAccessGrant.update({
            where: { id: grant.id },
            data: { status: 'REVOKED', revokedAt: now },
          });
          await transaction.auditEvent.create({
            data: {
              actorUserId: userId,
              action: 'node-access-grant.revoked',
              entityType: 'NodeAccessGrant',
              entityId: grant.id,
              metadata: { nodeId: grant.nodeId },
            },
          });
          continue;
        }
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
}
