import { z } from 'zod';

export const nodeAgentAcknowledgementSchema = z.object({
  nodeSyncJobId: z.string().uuid(),
  targetVersion: z.number().int().nonnegative(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type NodeAgentAcknowledgement = z.infer<
  typeof nodeAgentAcknowledgementSchema
>;

const nodeAccessGrantSyncRequestedEventSchema = z
  .object({
    nodeAccessGrantId: z.string().uuid(),
    nodeSyncJobId: z.string().uuid(),
    targetVersion: z.number().int().nonnegative(),
  })
  .strict();

const connectionRouteSyncRequestedEventSchema = z
  .object({
    routeEndpointId: z.string().uuid(),
    routeConnectionProfileId: z.string().uuid(),
    nodeSyncJobId: z.string().uuid(),
    targetVersion: z.number().int().positive(),
  })
  .strict();

export const nodeSyncRequestedEventSchema = z.union([
  nodeAccessGrantSyncRequestedEventSchema,
  connectionRouteSyncRequestedEventSchema,
]);

export type NodeSyncRequestedEvent = z.infer<
  typeof nodeSyncRequestedEventSchema
>;

const nodeAgentConnectionRouteSchema = z
  .object({
    activationVersion: z.number().int().positive(),
    endpoint: z
      .object({
        id: z.string().uuid(),
        host: z.string().min(1).max(253),
        addressKind: z.enum(['HOSTNAME', 'IPV4', 'IPV6']),
        port: z.number().int().min(1).max(65_535),
        priority: z.number().int().nonnegative(),
      })
      .strict(),
    profile: z
      .object({
        id: z.string().uuid(),
        profileKey: z.string().uuid(),
        version: z.number().int().positive(),
        protocolKind: z.enum(['VLESS', 'WIREGUARD']),
        transportKind: z.enum(['TCP', 'WEBSOCKET', 'GRPC']),
        securityKind: z.enum(['NONE', 'TLS', 'REALITY']),
        clientCompatibility: z.enum(['HAPP']),
        priority: z.number().int().nonnegative(),
      })
      .strict(),
    publicConfig: z
      .object({
        kind: z.literal('VLESS_TCP_TLS'),
        tlsServerName: z.string().min(1).max(253),
        displayName: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();

export const nodeAgentConfigurationSnapshotSchema = z
  .object({
    desiredConfigVersion: z.number().int().nonnegative(),
    appliedConfigVersion: z.number().int().nonnegative(),
    pendingAcknowledgement: nodeAgentAcknowledgementSchema.strict().nullable(),
    grants: z.array(
      z
        .object({
          id: z.string().uuid(),
          status: z.enum(['PENDING', 'ACTIVE', 'REVOKED']),
          expiresAt: z.string().datetime({ offset: true }),
          desiredVersion: z.number().int().nonnegative(),
          appliedVersion: z.number().int().nonnegative(),
          revokedAt: z.string().datetime({ offset: true }).nullable(),
          dataPlaneCredential: z.string().uuid().nullable(),
        })
        .strict(),
    ),
    routes: z.array(nodeAgentConnectionRouteSchema),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.appliedConfigVersion > snapshot.desiredConfigVersion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['appliedConfigVersion'],
        message: 'cannot exceed desiredConfigVersion',
      });
    }
    if (
      snapshot.pendingAcknowledgement !== null &&
      snapshot.pendingAcknowledgement.targetVersion !==
        snapshot.desiredConfigVersion
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pendingAcknowledgement', 'targetVersion'],
        message: 'must equal desiredConfigVersion',
      });
    }
    if (
      snapshot.pendingAcknowledgement !== null &&
      snapshot.desiredConfigVersion <= snapshot.appliedConfigVersion
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pendingAcknowledgement'],
        message: 'requires an unapplied desired version',
      });
    }
  });

export type NodeAgentConfigurationSnapshot = z.infer<
  typeof nodeAgentConfigurationSnapshotSchema
>;
