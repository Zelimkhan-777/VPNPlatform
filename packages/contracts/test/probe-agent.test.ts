import { describe, expect, it } from 'vitest';

import { acceptedProbeResultSchema, probeResultSubmissionSchema } from '../src';

const validSubmission = {
  sourceResultId: 'cycle-42-result-1',
  affectedScope: { kind: 'ENDPOINT' as const, id: 'endpoint:primary' },
  cycleStartedAt: '2026-09-08T20:00:00.000Z',
  routeVersion: 42,
  outcome: 'FAILURE' as const,
  failureClass: 'TCP_TLS' as const,
  controlHealthy: true,
};

describe('probe agent contracts', () => {
  it('accepts the exact bounded probe result wire format', () => {
    expect(probeResultSubmissionSchema.parse(validSubmission)).toEqual(
      validSubmission,
    );
    expect(
      acceptedProbeResultSchema.parse({
        probeResultId: '00000000-0000-4000-8000-000000000001',
        receivedAt: '2026-09-08T20:00:01.000Z',
        replayed: false,
      }),
    ).toBeTruthy();
  });

  it('rejects extra identity fields and malformed failure evidence', () => {
    expect(
      probeResultSubmissionSchema.safeParse({
        ...validSubmission,
        probeSourceId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false);
    expect(
      probeResultSubmissionSchema.safeParse({
        ...validSubmission,
        failureClass: undefined,
      }).success,
    ).toBe(false);
    expect(
      probeResultSubmissionSchema.safeParse({
        ...validSubmission,
        outcome: 'SUCCESS',
      }).success,
    ).toBe(false);
  });
});
