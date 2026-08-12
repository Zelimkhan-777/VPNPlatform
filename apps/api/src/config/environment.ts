import { isIP } from 'node:net';

import type { Provider } from '@nestjs/common';
import { z } from 'zod';

const connectionUrlSchema = (protocols: readonly string[]) =>
  z
    .string()
    .url()
    .refine((value) => protocols.includes(new URL(value).protocol), {
      message: `URL protocol must be one of: ${protocols.join(', ')}`,
    });

const httpUrlSchema = connectionUrlSchema(['http:', 'https:']).refine(
  (value) => {
    const parsed = new URL(value);
    return (
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash &&
      !parsed.username &&
      !parsed.password
    );
  },
  {
    message:
      'URL must be an origin without a path, query, fragment, or credentials',
  },
);

const booleanEnvironmentValueSchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const trustedProxyIpsSchema = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .refine((entries) => entries.every((entry) => isIP(entry) !== 0), {
    message: 'must be a comma-separated list of IP addresses',
  });

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
    TRUSTED_PROXY_IPS: trustedProxyIpsSchema,
    TELEGRAM_WEB_APP_BOT_TOKEN: z.string().min(1).optional(),
    AUTH_SESSION_PEPPER: z.string().min(32).optional(),
    SUBSCRIPTION_TOKEN_PEPPER: z.string().min(32).optional(),
    SUBSCRIPTION_FEED_BASE_URL: httpUrlSchema.optional(),
    CABINET_ORIGIN: httpUrlSchema.optional(),
    SUBSCRIPTION_FEED_RATE_LIMIT_MAX: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(60),
    SUBSCRIPTION_FEED_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(60_000),
    AUTH_SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(2_592_000)
      .default(604_800),
    TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(3_600)
      .default(300),
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

    if (
      environment.NODE_ENV === 'production' &&
      !environment.TELEGRAM_WEB_APP_BOT_TOKEN
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TELEGRAM_WEB_APP_BOT_TOKEN'],
        message: 'is required in production',
      });
    }

    if (
      environment.NODE_ENV === 'production' &&
      !environment.AUTH_SESSION_PEPPER
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_SESSION_PEPPER'],
        message: 'is required in production',
      });
    }

    if (
      environment.NODE_ENV === 'production' &&
      !environment.SUBSCRIPTION_TOKEN_PEPPER
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUBSCRIPTION_TOKEN_PEPPER'],
        message: 'is required in production',
      });
    }

    for (const key of [
      'SUBSCRIPTION_FEED_BASE_URL',
      'CABINET_ORIGIN',
    ] as const) {
      if (environment.NODE_ENV === 'production' && !environment[key]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'is required in production',
        });
      }
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
