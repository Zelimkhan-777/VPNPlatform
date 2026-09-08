import { z } from 'zod';

const databaseIntegerSchema = z.number().int().min(0).max(2_147_483_647);

export const probeResultSubmissionSchema = z
  .object({
    sourceResultId: z.string().trim().min(1).max(128),
    affectedScope: z
      .object({
        kind: z.enum(['PROFILE', 'ENDPOINT', 'NODE', 'PROVIDER_ASN']),
        id: z.string().trim().min(1).max(128),
      })
      .strict(),
    cycleStartedAt: z.string().datetime({ offset: true }),
    routeVersion: databaseIntegerSchema,
    outcome: z.enum(['SUCCESS', 'FAILURE', 'PROBE_SOURCE_FAILURE']),
    failureClass: z
      .enum(['DNS', 'TCP_TLS', 'VPN_HANDSHAKE', 'TEST_TRAFFIC'])
      .optional(),
    controlHealthy: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === 'FAILURE' && !value.failureClass) {
      context.addIssue({
        code: 'custom',
        path: ['failureClass'],
        message: 'failureClass is required for route failures',
      });
    }
    if (value.outcome !== 'FAILURE' && value.failureClass) {
      context.addIssue({
        code: 'custom',
        path: ['failureClass'],
        message: 'failureClass is allowed only for route failures',
      });
    }
  });

export const probeResultSubmissionOpenApiSchema = (() => {
  const schema = z.toJSONSchema(probeResultSubmissionSchema, {
    target: 'draft-7',
  });
  delete schema.$schema;
  return schema;
})();

export const acceptedProbeResultSchema = z
  .object({
    probeResultId: z.string().uuid(),
    receivedAt: z.string().datetime({ offset: true }),
    replayed: z.boolean(),
  })
  .strict();

export type ProbeResultSubmission = z.infer<typeof probeResultSubmissionSchema>;
export type AcceptedProbeResult = z.infer<typeof acceptedProbeResultSchema>;
