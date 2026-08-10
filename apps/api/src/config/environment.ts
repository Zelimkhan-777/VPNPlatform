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

export const apiEnvironmentSchema = z.object({
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
  LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED:
    booleanEnvironmentValueSchema.default(false),
  LOCAL_SUBSCRIPTION_PROTOTYPE_TOKEN: z.string().min(32).optional(),
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
