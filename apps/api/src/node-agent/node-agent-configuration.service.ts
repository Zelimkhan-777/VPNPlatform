import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { NodeAgentConfigurationSnapshot } from '@vpn-platform/contracts';
import { createHash } from 'node:crypto';

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

    const grants = node.nodeAccessGrants.map((grant) => {
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
    });
    const routeRows = await transaction.$queryRaw<
      {
        activationVersion: number;
        endpointId: string;
        endpointHost: string;
        endpointAddressKind: 'HOSTNAME' | 'IPV4' | 'IPV6';
        endpointPort: number;
        endpointPriority: number;
        profileId: string;
        profileKey: string;
        profileVersion: number;
        protocolKind: 'VLESS' | 'WIREGUARD';
        transportKind: 'TCP' | 'WEBSOCKET' | 'GRPC';
        securityKind: 'NONE' | 'TLS' | 'REALITY';
        clientCompatibility: 'HAPP';
        profilePriority: number;
        tlsServerName: string;
        displayName: string;
      }[]
    >`
      SELECT
        route."activationVersion" AS "activationVersion",
        endpoint."id" AS "endpointId",
        endpoint."host" AS "endpointHost",
        endpoint."addressKind"::text AS "endpointAddressKind",
        endpoint."port" AS "endpointPort",
        endpoint."priority" AS "endpointPriority",
        profile."id" AS "profileId",
        profile."profileKey"::text AS "profileKey",
        profile."version" AS "profileVersion",
        profile."protocolKind"::text AS "protocolKind",
        profile."transportKind"::text AS "transportKind",
        profile."securityKind"::text AS "securityKind",
        profile."clientCompatibility"::text AS "clientCompatibility",
        profile."priority" AS "profilePriority",
        public_config."tlsServerName" AS "tlsServerName",
        public_config."displayName" AS "displayName"
      FROM "EndpointConnectionProfile" AS route
      INNER JOIN "Endpoint" AS endpoint
        ON endpoint."id" = route."endpointId"
        AND endpoint."nodeId" = route."nodeId"
        AND endpoint."status" = CAST('ACTIVE' AS "EndpointStatus")
      INNER JOIN "ConnectionProfile" AS profile
        ON profile."id" = route."connectionProfileId"
        AND profile."nodeId" = route."nodeId"
        AND profile."status" = CAST('ACTIVE' AS "ConnectionProfileStatus")
      INNER JOIN "VlessTcpTlsPublicConfig" AS public_config
        ON public_config."connectionProfileId" = profile."id"
      WHERE route."nodeId" = CAST(${nodeId} AS uuid)
        AND route."activationVersion" IS NOT NULL
        AND route."activationVersion" <= ${node.desiredConfigVersion}
      ORDER BY
        route."activationVersion" ASC,
        endpoint."id" ASC,
        profile."id" ASC
    `;
    const routes = routeRows.map((route) => ({
      activationVersion: route.activationVersion,
      endpoint: {
        id: route.endpointId,
        host: route.endpointHost,
        addressKind: route.endpointAddressKind,
        port: route.endpointPort,
        priority: route.endpointPriority,
      },
      profile: {
        id: route.profileId,
        profileKey: route.profileKey,
        version: route.profileVersion,
        protocolKind: route.protocolKind,
        transportKind: route.transportKind,
        securityKind: route.securityKind,
        clientCompatibility: route.clientCompatibility,
        priority: route.profilePriority,
      },
      publicConfig: {
        kind: 'VLESS_TCP_TLS' as const,
        tlsServerName: route.tlsServerName,
        displayName: route.displayName,
      },
    }));
    const snapshotHash = createHash('sha256')
      .update(
        JSON.stringify({
          targetVersion: node.desiredConfigVersion,
          grants,
          routes,
        }),
      )
      .digest('hex');
    if (pendingAcknowledgement) {
      await transaction.nodeConfigDelivery.createMany({
        data: [
          {
            nodeId,
            nodeSyncJobId: pendingAcknowledgement.id,
            targetVersion: pendingAcknowledgement.targetVersion,
            snapshotHash,
          },
        ],
        skipDuplicates: true,
      });
    }

    return {
      desiredConfigVersion: node.desiredConfigVersion,
      appliedConfigVersion: node.appliedConfigVersion,
      pendingAcknowledgement: pendingAcknowledgement
        ? {
            nodeSyncJobId: pendingAcknowledgement.id,
            targetVersion: pendingAcknowledgement.targetVersion,
            snapshotHash,
          }
        : null,
      grants,
      routes,
    };
  }
}
