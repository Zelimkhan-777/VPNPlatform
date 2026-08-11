import { Inject, Injectable } from '@nestjs/common';
import { NodeStatus } from '@prisma/client';
import { createHmac, randomBytes } from 'node:crypto';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';

const nodeAgentCredentialPattern = /^[A-Za-z0-9_-]{43}$/;

export type IssuedNodeAgentCredential = {
  credentialId: string;
  secret: string;
};

@Injectable()
export class NodeAgentCredentialService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  async rotate(
    nodeId: string,
    now = new Date(),
  ): Promise<IssuedNodeAgentCredential> {
    const secret = randomBytes(32).toString('base64url');
    const secretHash = this.hashSecret(secret);

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`node-agent-credential:${nodeId}`}))
      `;
      await transaction.node.findUniqueOrThrow({
        where: { id: nodeId },
        select: { id: true },
      });
      await transaction.nodeAgentCredential.updateMany({
        where: { nodeId, revokedAt: null },
        data: { revokedAt: now },
      });
      const credential = await transaction.nodeAgentCredential.create({
        data: { nodeId, secretHash },
        select: { id: true },
      });
      await transaction.auditEvent.create({
        data: {
          action: 'node-agent-credential.rotated',
          entityType: 'Node',
          entityId: nodeId,
          metadata: { credentialId: credential.id },
        },
      });

      return { credentialId: credential.id, secret };
    });
  }

  async revoke(nodeId: string, now = new Date()): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`node-agent-credential:${nodeId}`}))
      `;
      const result = await transaction.nodeAgentCredential.updateMany({
        where: { nodeId, revokedAt: null },
        data: { revokedAt: now },
      });
      if (result.count === 0) return false;

      await transaction.auditEvent.create({
        data: {
          action: 'node-agent-credential.revoked',
          entityType: 'Node',
          entityId: nodeId,
        },
      });
      return true;
    });
  }

  async authenticate(secret: string): Promise<string | null> {
    if (!nodeAgentCredentialPattern.test(secret)) return null;

    const credential = await this.prisma.nodeAgentCredential.findFirst({
      where: {
        secretHash: this.hashSecret(secret),
        revokedAt: null,
        node: { is: { status: NodeStatus.HEALTHY } },
      },
      select: { nodeId: true },
    });
    return credential?.nodeId ?? null;
  }

  private hashSecret(secret: string): string {
    const pepper = this.environment.NODE_AGENT_CREDENTIAL_PEPPER;
    if (!pepper) {
      throw new Error('Node agent credential pepper is not configured');
    }
    return createHmac('sha256', pepper).update(secret).digest('hex');
  }
}
