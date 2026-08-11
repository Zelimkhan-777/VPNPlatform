import { z } from 'zod';

export const nodeAgentAcknowledgementSchema = z.object({
  nodeSyncJobId: z.string().uuid(),
  targetVersion: z.number().int().nonnegative(),
});

export type NodeAgentAcknowledgement = z.infer<
  typeof nodeAgentAcknowledgementSchema
>;
