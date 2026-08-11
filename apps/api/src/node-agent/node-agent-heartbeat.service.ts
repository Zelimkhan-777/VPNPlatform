import { Inject, Injectable } from '@nestjs/common';
import { NodeStatus } from '@prisma/client';

import { PrismaService } from '../database/prisma.service';

@Injectable()
export class NodeAgentHeartbeatService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async record(nodeId: string, now = new Date()): Promise<boolean> {
    const result = await this.prisma.node.updateMany({
      where: { id: nodeId, status: NodeStatus.HEALTHY },
      data: { lastHealthCheckAt: now },
    });
    return result.count === 1;
  }
}
