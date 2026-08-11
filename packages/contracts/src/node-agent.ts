import { z } from 'zod';

export const nodeAgentAcknowledgementSchema = z.object({
  nodeSyncJobId: z.string().uuid(),
  targetVersion: z.number().int().nonnegative(),
});

export type NodeAgentAcknowledgement = z.infer<
  typeof nodeAgentAcknowledgementSchema
>;

export const nodeAgentConfigurationSnapshotSchema = z.object({
  desiredConfigVersion: z.number().int().nonnegative(),
  appliedConfigVersion: z.number().int().nonnegative(),
  grants: z.array(
    z.object({
      id: z.string().uuid(),
      status: z.enum(['PENDING', 'ACTIVE', 'REVOKED']),
      expiresAt: z.string().datetime({ offset: true }),
      desiredVersion: z.number().int().nonnegative(),
      appliedVersion: z.number().int().nonnegative(),
      revokedAt: z.string().datetime({ offset: true }).nullable(),
    }),
  ),
});

export type NodeAgentConfigurationSnapshot = z.infer<
  typeof nodeAgentConfigurationSnapshotSchema
>;
