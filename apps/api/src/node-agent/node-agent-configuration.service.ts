import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { NodeAgentConfigurationSnapshot } from '@vpn-platform/contracts';

import { PrismaService } from '../database/prisma.service';

@Injectable()
export class NodeAgentConfigurationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async snapshotInTransaction(
    transaction: Prisma.TransactionClient,
    nodeId: string,
  ): Promise<NodeAgentConfigurationSnapshot> {
    const node = await transaction.node.findUniqueOrThrow({
      where: { id: nodeId },
      select: {
        desiredConfigVersion: true,
        appliedConfigVersion: true,
        nodeAccessGrants: {
          orderBy: [{ desiredVersion: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            status: true,
            expiresAt: true,
            desiredVersion: true,
            appliedVersion: true,
            revokedAt: true,
          },
        },
      },
    });
    const pendingAcknowledgement =
      node.desiredConfigVersion > node.appliedConfigVersion
        ? await transaction.nodeSyncJob.findFirst({
            where: {
              nodeId,
              targetVersion: node.desiredConfigVersion,
              status: 'SUCCEEDED',
              configAcknowledgement: null,
            },
            orderBy: [{ completedAt: 'desc' }, { id: 'asc' }],
            select: { id: true, targetVersion: true },
          })
        : null;
    return {
      desiredConfigVersion: node.desiredConfigVersion,
      appliedConfigVersion: node.appliedConfigVersion,
      pendingAcknowledgement: pendingAcknowledgement
        ? {
            nodeSyncJobId: pendingAcknowledgement.id,
            targetVersion: pendingAcknowledgement.targetVersion,
          }
        : null,
      grants: node.nodeAccessGrants.map((grant) => ({
        ...grant,
        expiresAt: grant.expiresAt.toISOString(),
        revokedAt: grant.revokedAt?.toISOString() ?? null,
      })),
    };
  }
}
