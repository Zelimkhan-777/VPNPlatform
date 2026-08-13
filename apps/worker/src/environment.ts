import { randomUUID } from 'node:crypto';

import { z } from 'zod';

const connectionUrlSchema = (protocols: readonly string[]) =>
  z
    .string()
    .url()
    .refine((value) => protocols.includes(new URL(value).protocol), {
      message: `URL protocol must be one of: ${protocols.join(', ')}`,
    });

const workerEnvironmentSchema = z
  .object({
    WORKER_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    DATABASE_URL: connectionUrlSchema(['postgresql:', 'postgres:']).optional(),
    REDIS_URL: connectionUrlSchema(['redis:', 'rediss:']).optional(),
    WORKER_QUEUE_NAME: z.string().min(1).max(128).default('node-sync'),
    WORKER_ID: z.string().min(1).max(128).optional(),
    WORKER_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(1_000),
    WORKER_RETRY_DELAY_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(5_000),
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
    LOG_LEVEL: z.string().min(1).default('info'),
  })
  .superRefine((environment, context) => {
    if (!environment.WORKER_ENABLED) return;
    for (const key of ['DATABASE_URL', 'REDIS_URL'] as const) {
      if (!environment[key]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'is required when WORKER_ENABLED=true',
        });
      }
    }
  });

export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema> & {
  workerId: string;
};

export function parseWorkerEnvironment(
  environment: NodeJS.ProcessEnv,
): WorkerEnvironment {
  const parsed = workerEnvironmentSchema.parse(environment);
  return {
    ...parsed,
    workerId: parsed.WORKER_ID ?? `worker-${randomUUID()}`,
  };
}
