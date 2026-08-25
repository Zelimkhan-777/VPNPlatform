import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  DEFAULT_COMPLETED_JOB_RETENTION_COUNT,
  DEFAULT_COMPLETED_JOB_RETENTION_SECONDS,
  DEFAULT_FAILED_JOB_RETENTION_COUNT,
  DEFAULT_FAILED_JOB_RETENTION_SECONDS,
} from './job-retention';

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
    NODE_SYNC_RETRY_DELAY_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
    NODE_SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    WORKER_COMPLETED_JOB_RETENTION_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(365 * 24 * 60 * 60)
      .default(DEFAULT_COMPLETED_JOB_RETENTION_SECONDS),
    WORKER_COMPLETED_JOB_RETENTION_COUNT: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .default(DEFAULT_COMPLETED_JOB_RETENTION_COUNT),
    WORKER_FAILED_JOB_RETENTION_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(365 * 24 * 60 * 60)
      .default(DEFAULT_FAILED_JOB_RETENTION_SECONDS),
    WORKER_FAILED_JOB_RETENTION_COUNT: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .default(DEFAULT_FAILED_JOB_RETENTION_COUNT),
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
    if (
      environment.NODE_SYNC_RETRY_DELAY_MS <
      environment.ORCHESTRATION_LEASE_DURATION_MS
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NODE_SYNC_RETRY_DELAY_MS'],
        message: 'must be at least ORCHESTRATION_LEASE_DURATION_MS',
      });
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
