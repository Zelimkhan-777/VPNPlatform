import { z } from 'zod';

export const livenessResponseSchema = z.object({
  status: z.literal('ok'),
});

export const dependencyStatusSchema = z.enum(['up', 'down']);

export const readinessResponseSchema = z.object({
  status: z.enum(['ready', 'unavailable']),
  dependencies: z.object({
    postgres: dependencyStatusSchema,
    redis: dependencyStatusSchema,
  }),
});

export type LivenessResponse = z.infer<typeof livenessResponseSchema>;
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
