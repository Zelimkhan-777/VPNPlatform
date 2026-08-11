import { Inject, Injectable } from '@nestjs/common';
import { NodeStatus } from '@prisma/client';
import type { NodeAgentConfigurationSnapshot } from '@vpn-platform/contracts';

import { PrismaService } from '../database/prisma.service';

@Injectable()
export class NodeAgentConfigurationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async snapshot(
    nodeId: string,
  ): Promise<NodeAgentConfigurationSnapshot | null> {
    const node = await this.prisma.node.findFirst({
      where: { id: nodeId, status: NodeStatus.HEALTHY },
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
    if (!node) return null;

    return {
      desiredConfigVersion: node.desiredConfigVersion,
      appliedConfigVersion: node.appliedConfigVersion,
      grants: node.nodeAccessGrants.map((grant) => ({
        ...grant,
        expiresAt: grant.expiresAt.toISOString(),
        revokedAt: grant.revokedAt?.toISOString() ?? null,
      })),
    };
  }
}
