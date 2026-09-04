import { isIP } from 'node:net';

import type { Provider } from '@nestjs/common';
import { z } from 'zod';

import { readPrivateSecretFile } from './private-secret-file';

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
    API_REDIS_KEY_NAMESPACE: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9:_-]+$/)
      .default('vpn-platform:api'),
    HEALTH_CHECK_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(5_000)
      .default(750),
    LOG_LEVEL: z.string().min(1).default('info'),
    TRUSTED_PROXY_IPS: trustedProxyIpsSchema,
    TELEGRAM_WEB_APP_BOT_TOKEN: z.string().min(1).optional(),
    BOT_SIGNING_KEK: z
      .string()
      .length(43)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    BOT_SIGNING_KEK_FILE: z.string().min(1).optional(),
    BOT_SIGNING_KEK_GID: z.coerce.number().int().min(1).max(65_535).optional(),
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
    SUBSCRIPTION_FEED_RENDERING_ENABLED:
      booleanEnvironmentValueSchema.default(false),
    SUBSCRIPTION_FEED_MAX_ROUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
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
    AUTH_PRELAUNCH_RATE_LIMIT_MAX: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(10),
    AUTH_PRELAUNCH_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(3_600_000)
      .default(60_000),
    AUTH_CHALLENGE_CLEANUP_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(100),
    TRIAL_ACTIVATION_RATE_LIMIT_MAX: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(5),
    TRIAL_ACTIVATION_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(3_600_000)
      .default(60_000),
    NODE_AGENT_CREDENTIAL_PEPPER: z.string().min(32).optional(),
    DATA_PLANE_CREDENTIAL_PEPPER: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43,}$/)
      .optional(),
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
  })
  .superRefine((environment, context) => {
    if (environment.BOT_SIGNING_KEK && environment.BOT_SIGNING_KEK_FILE) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BOT_SIGNING_KEK_FILE'],
        message: 'cannot be combined with BOT_SIGNING_KEK',
      });
    }

    if (environment.NODE_ENV === 'production') {
      if (environment.BOT_SIGNING_KEK) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['BOT_SIGNING_KEK'],
          message:
            'must be supplied through BOT_SIGNING_KEK_FILE in production',
        });
      }
      if (!environment.BOT_SIGNING_KEK_FILE) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['BOT_SIGNING_KEK_FILE'],
          message: 'is required in production',
        });
      }
      if (!environment.BOT_SIGNING_KEK_GID) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['BOT_SIGNING_KEK_GID'],
          message: 'is required in production',
        });
      }
    }

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
      !environment.DATA_PLANE_CREDENTIAL_PEPPER
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATA_PLANE_CREDENTIAL_PEPPER'],
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
      if (environment.NODE_ENV === 'production') {
        const value = environment[key];
        if (!value) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'is required in production',
          });
        } else if (new URL(value).protocol !== 'https:') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'must use HTTPS in production',
          });
        }
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

export function loadApiEnvironment(
  environment: NodeJS.ProcessEnv,
): ApiEnvironment {
  const parsed = parseApiEnvironment(environment);
  if (!parsed.BOT_SIGNING_KEK_FILE) return parsed;
  return {
    ...parsed,
    BOT_SIGNING_KEK: readPrivateSecretFile(
      parsed.BOT_SIGNING_KEK_FILE,
      /^[A-Za-z0-9_-]{43}\n?$/,
      'Bot signing KEK',
      parsed.BOT_SIGNING_KEK_GID,
    ),
  };
}

export const apiEnvironmentProvider: Provider<ApiEnvironment> = {
  provide: API_ENVIRONMENT,
  useFactory: () => loadApiEnvironment(process.env),
};
