import { z } from 'zod';

const nodeAgentEnvironmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    NODE_AGENT_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    NODE_AGENT_API_BASE_URL: z.string().url().optional(),
    NODE_AGENT_CREDENTIAL: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
    NODE_AGENT_MODE: z.enum(['simulation']).default('simulation'),
    NODE_AGENT_STATE_FILE: z
      .string()
      .min(1)
      .max(1_024)
      .default('./var/node-agent/state.json'),
    NODE_AGENT_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
    NODE_AGENT_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(30_000)
      .default(5_000),
    LOG_LEVEL: z.string().min(1).default('info'),
  })
  .superRefine((environment, context) => {
    if (!environment.NODE_AGENT_ENABLED) return;
    for (const key of [
      'NODE_AGENT_API_BASE_URL',
      'NODE_AGENT_CREDENTIAL',
    ] as const) {
      if (!environment[key]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'is required when NODE_AGENT_ENABLED=true',
        });
      }
    }
    if (environment.NODE_ENV === 'production') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NODE_AGENT_MODE'],
        message: 'simulation mode is forbidden in production',
      });
    }
    if (environment.NODE_AGENT_API_BASE_URL) {
      const url = new URL(environment.NODE_AGENT_API_BASE_URL);
      const localHttp =
        url.protocol === 'http:' &&
        environment.NODE_ENV !== 'production' &&
        (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
      if (url.protocol !== 'https:' && !localHttp) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['NODE_AGENT_API_BASE_URL'],
          message: 'must use HTTPS except for local development',
        });
      }
      if (url.username || url.password || url.search || url.hash) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['NODE_AGENT_API_BASE_URL'],
          message: 'must not contain credentials, query, or fragment',
        });
      }
    }
  });

export type NodeAgentEnvironment = z.infer<typeof nodeAgentEnvironmentSchema>;

export function parseNodeAgentEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeAgentEnvironment {
  return nodeAgentEnvironmentSchema.parse(environment);
}
