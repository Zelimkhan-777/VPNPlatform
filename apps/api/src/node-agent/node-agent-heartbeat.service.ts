import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../database/prisma.service';

@Injectable()
export class NodeAgentHeartbeatService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async recordInTransaction(
    transaction: Prisma.TransactionClient,
    nodeId: string,
    now = new Date(),
  ): Promise<void> {
    await transaction.node.update({
      where: { id: nodeId },
      data: { lastHealthCheckAt: now },
    });
  }
}
