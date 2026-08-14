import { Inject, Injectable } from '@nestjs/common';
import { isIP } from 'node:net';
import { z } from 'zod';

import { PrismaService } from '../database/prisma.service';

const selectionInputSchema = z.object({
  userId: z.string().uuid(),
  deviceId: z.string().uuid(),
});

const endpointInputSchema = z
  .object({
    addressKind: z.enum(['HOSTNAME', 'IPV4', 'IPV6']),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    priority: z.number().int().min(0),
  })
  .superRefine(({ addressKind, host }, context) => {
    const hostname =
      /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
    const isValid =
      (addressKind === 'HOSTNAME' && hostname.test(host)) ||
      (addressKind === 'IPV4' && isIP(host) === 4) ||
      (addressKind === 'IPV6' && isIP(host) === 6);

    if (!isValid) {
      context.addIssue({
        code: 'custom',
        path: ['host'],
        message: 'Host does not match its address kind',
      });
    }
  });

const connectionProfileInputSchema = z.object({
  version: z.number().int().min(1),
  priority: z.number().int().min(0),
  protocolKind: z.enum(['VLESS', 'WIREGUARD']),
  transportKind: z.enum(['TCP', 'WEBSOCKET', 'GRPC']),
  securityKind: z.enum(['NONE', 'TLS', 'REALITY']),
  clientCompatibility: z.enum(['HAPP']),
});

const connectionRouteProjectionSchema = z.object({
  endpointId: z.string().uuid(),
  endpointHost: z.string().min(1).max(253),
  endpointAddressKind: z.enum(['HOSTNAME', 'IPV4', 'IPV6']),
  endpointPort: z.number().int().min(1).max(65_535),
  endpointPriority: z.number().int().min(0),
  nodeId: z.string().uuid(),
  profileId: z.string().uuid(),
  profileKey: z.string().uuid(),
  profileVersion: z.number().int().min(1),
  profilePriority: z.number().int().min(0),
  protocolKind: z.enum(['VLESS', 'WIREGUARD']),
  transportKind: z.enum(['TCP', 'WEBSOCKET', 'GRPC']),
  securityKind: z.enum(['NONE', 'TLS', 'REALITY']),
  clientCompatibility: z.enum(['HAPP']),
});

export type ConnectionRouteSelectionInput = z.infer<
  typeof selectionInputSchema
>;
export type EndpointInput = z.infer<typeof endpointInputSchema>;
export type ConnectionProfileInput = z.infer<
  typeof connectionProfileInputSchema
>;
export type ConnectionRouteProjection = z.infer<
  typeof connectionRouteProjectionSchema
>;

export function validateEndpointInput(input: unknown): EndpointInput {
  return endpointInputSchema.parse(input);
}

export function validateConnectionProfileInput(
  input: unknown,
): ConnectionProfileInput {
  return connectionProfileInputSchema.parse(input);
}

@Injectable()
export class ConnectionRouteSelectionService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async selectForAuthorizedDevice(
    input: ConnectionRouteSelectionInput,
  ): Promise<ConnectionRouteProjection[]> {
    const selection = selectionInputSchema.parse(input);
    const routes = await this.prisma.$queryRaw<ConnectionRouteProjection[]>`
      SELECT
        endpoint."id" AS "endpointId",
        endpoint."host" AS "endpointHost",
        endpoint."addressKind"::text AS "endpointAddressKind",
        endpoint."port" AS "endpointPort",
        endpoint."priority" AS "endpointPriority",
        node."id" AS "nodeId",
        profile."id" AS "profileId",
        profile."profileKey" AS "profileKey",
        profile."version" AS "profileVersion",
        profile."priority" AS "profilePriority",
        profile."protocolKind"::text AS "protocolKind",
        profile."transportKind"::text AS "transportKind",
        profile."securityKind"::text AS "securityKind",
        profile."clientCompatibility"::text AS "clientCompatibility"
      FROM "Device" AS device
      INNER JOIN "Subscription" AS subscription
        ON subscription."userId" = device."userId"
        AND subscription."status" = CAST('ACTIVE' AS "SubscriptionStatus")
        AND subscription."expiresAt" > clock_timestamp()
      INNER JOIN "NodeAccessGrant" AS access_grant
        ON access_grant."deviceId" = device."id"
        AND access_grant."status" = CAST('ACTIVE' AS "NodeAccessGrantStatus")
        AND access_grant."expiresAt" > clock_timestamp()
      INNER JOIN "Node" AS node
        ON node."id" = access_grant."nodeId"
        AND node."status" = CAST('HEALTHY' AS "NodeStatus")
      INNER JOIN "EndpointConnectionProfile" AS route
        ON route."nodeId" = node."id"
      INNER JOIN "Endpoint" AS endpoint
        ON endpoint."id" = route."endpointId"
        AND endpoint."nodeId" = node."id"
        AND endpoint."status" = CAST('ACTIVE' AS "EndpointStatus")
      INNER JOIN "ConnectionProfile" AS profile
        ON profile."id" = route."connectionProfileId"
        AND profile."nodeId" = node."id"
        AND profile."status" = CAST('ACTIVE' AS "ConnectionProfileStatus")
      WHERE device."id" = ${selection.deviceId}::uuid
        AND device."userId" = ${selection.userId}::uuid
        AND device."status" = CAST('ACTIVE' AS "DeviceStatus")
      ORDER BY
        profile."priority" ASC,
        endpoint."priority" ASC,
        node."id" ASC,
        profile."profileKey" ASC,
        profile."version" DESC,
        endpoint."id" ASC
    `;

    return z.array(connectionRouteProjectionSchema).parse(routes);
  }
}
