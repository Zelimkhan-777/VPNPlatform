import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { NodeAgentConfigurationSnapshot } from '@vpn-platform/contracts';

import { PrismaService } from '../database/prisma.service';
import {
  DATA_PLANE_CREDENTIAL_DERIVATION_VERSION,
  DataPlaneCredentialService,
} from '../orchestration/data-plane-credential.service';

@Injectable()
export class NodeAgentConfigurationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DataPlaneCredentialService)
    private readonly dataPlaneCredentials: DataPlaneCredentialService,
  ) {}

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
            dataPlaneCredentialHash: true,
            dataPlaneCredentialDerivationVersion: true,
            deviceId: true,
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
    const databaseClock = await transaction.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS "now"
    `;
    const now = databaseClock[0]?.now;
    if (!now) throw new Error('PostgreSQL clock is unavailable');

    return {
      desiredConfigVersion: node.desiredConfigVersion,
      appliedConfigVersion: node.appliedConfigVersion,
      pendingAcknowledgement: pendingAcknowledgement
        ? {
            nodeSyncJobId: pendingAcknowledgement.id,
            targetVersion: pendingAcknowledgement.targetVersion,
          }
        : null,
      grants: node.nodeAccessGrants.map((grant) => {
        const eligible =
          grant.status !== 'REVOKED' &&
          grant.expiresAt > now &&
          grant.dataPlaneCredentialDerivationVersion ===
            DATA_PLANE_CREDENTIAL_DERIVATION_VERSION;
        const dataPlaneCredential = eligible
          ? this.dataPlaneCredentials.derive({
              grantId: grant.id,
              deviceId: grant.deviceId,
              nodeId,
            })
          : null;
        return {
          id: grant.id,
          status: grant.status,
          expiresAt: grant.expiresAt.toISOString(),
          desiredVersion: grant.desiredVersion,
          appliedVersion: grant.appliedVersion,
          revokedAt: grant.revokedAt?.toISOString() ?? null,
          dataPlaneCredential:
            dataPlaneCredential &&
            this.dataPlaneCredentials.verifyHash(
              dataPlaneCredential,
              grant.dataPlaneCredentialHash,
            )
              ? dataPlaneCredential
              : null,
        };
      }),
    };
  }
}
