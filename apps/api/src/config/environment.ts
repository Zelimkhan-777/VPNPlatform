import type { Provider } from '@nestjs/common';
import { z } from 'zod';

const connectionUrlSchema = (protocols: readonly string[]) =>
  z
    .string()
    .url()
    .refine((value) => protocols.includes(new URL(value).protocol), {
      message: `URL protocol must be one of: ${protocols.join(', ')}`,
    });

const booleanEnvironmentValueSchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

export const apiEnvironmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    DATABASE_URL: connectionUrlSchema(['postgresql:', 'postgres:']),
    REDIS_URL: connectionUrlSchema(['redis:', 'rediss:']),
    HEALTH_CHECK_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(5_000)
      .default(750),
    LOG_LEVEL: z.string().min(1).default('info'),
    NODE_AGENT_CREDENTIAL_PEPPER: z.string().min(32).optional(),
    LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED:
      booleanEnvironmentValueSchema.default(false),
    LOCAL_SUBSCRIPTION_PROTOTYPE_TOKEN: z.string().min(32).optional(),
    LOCAL_SUBSCRIPTION_PROTOTYPE_CONTENT: z
      .string()
      .min(1)
      .max(16_384)
      .optional(),
    LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_MAX: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(5),
    LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(60_000),
    LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_MAX_CLIENTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(100_000)
      .default(10_000),
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
  })
  .superRefine((environment, context) => {
    if (
      environment.LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED &&
      !environment.LOCAL_SUBSCRIPTION_PROTOTYPE_TOKEN
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOCAL_SUBSCRIPTION_PROTOTYPE_TOKEN'],
        message: 'is required when the local subscription prototype is enabled',
      });
    }

    if (
      environment.NODE_ENV === 'production' &&
      environment.LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED'],
        message: 'must remain disabled in production',
      });
    }

    if (
      environment.NODE_ENV === 'production' &&
      !environment.NODE_AGENT_CREDENTIAL_PEPPER
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NODE_AGENT_CREDENTIAL_PEPPER'],
        message: 'is required in production',
      });
    }
  });

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;

export const API_ENVIRONMENT = Symbol('API_ENVIRONMENT');

export function parseApiEnvironment(
  environment: NodeJS.ProcessEnv,
): ApiEnvironment {
  return apiEnvironmentSchema.parse(environment);
}

export const apiEnvironmentProvider: Provider<ApiEnvironment> = {
  provide: API_ENVIRONMENT,
  useFactory: () => parseApiEnvironment(process.env),
};
