import { z } from 'zod';

export const orchestrationStoreEnvironmentSchema = z.object({
  ORCHESTRATION_LEASE_DURATION_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(30_000),
  ORCHESTRATION_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(5),
});

export type OrchestrationStoreEnvironment = z.infer<
  typeof orchestrationStoreEnvironmentSchema
>;

export function parseOrchestrationStoreEnvironment(
  environment: NodeJS.ProcessEnv,
): OrchestrationStoreEnvironment {
  return orchestrationStoreEnvironmentSchema.parse(environment);
}
