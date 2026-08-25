import type { JobsOptions } from 'bullmq';

export const DEFAULT_COMPLETED_JOB_RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_COMPLETED_JOB_RETENTION_COUNT = 10_000;
export const DEFAULT_FAILED_JOB_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_FAILED_JOB_RETENTION_COUNT = 10_000;

export type BullMqJobRetention = Required<
  Pick<JobsOptions, 'removeOnComplete' | 'removeOnFail'>
>;

export type BullMqJobRetentionConfig = {
  completedAgeSeconds: number;
  completedCount: number;
  failedAgeSeconds: number;
  failedCount: number;
};

export function createBullMqJobRetention(
  config: BullMqJobRetentionConfig,
): BullMqJobRetention {
  return {
    removeOnComplete: {
      age: config.completedAgeSeconds,
      count: config.completedCount,
    },
    removeOnFail: {
      age: config.failedAgeSeconds,
      count: config.failedCount,
    },
  };
}

export const defaultBullMqJobRetention = createBullMqJobRetention({
  completedAgeSeconds: DEFAULT_COMPLETED_JOB_RETENTION_SECONDS,
  completedCount: DEFAULT_COMPLETED_JOB_RETENTION_COUNT,
  failedAgeSeconds: DEFAULT_FAILED_JOB_RETENTION_SECONDS,
  failedCount: DEFAULT_FAILED_JOB_RETENTION_COUNT,
});
