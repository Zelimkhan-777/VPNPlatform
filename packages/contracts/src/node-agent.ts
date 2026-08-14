import { z } from 'zod';

export const nodeAgentAcknowledgementSchema = z.object({
  nodeSyncJobId: z.string().uuid(),
  targetVersion: z.number().int().nonnegative(),
});

export type NodeAgentAcknowledgement = z.infer<
  typeof nodeAgentAcknowledgementSchema
>;

export const nodeSyncRequestedEventSchema = z
  .object({
    nodeAccessGrantId: z.string().uuid(),
    nodeSyncJobId: z.string().uuid(),
    targetVersion: z.number().int().nonnegative(),
  })
  .strict();

export type NodeSyncRequestedEvent = z.infer<
  typeof nodeSyncRequestedEventSchema
>;

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
