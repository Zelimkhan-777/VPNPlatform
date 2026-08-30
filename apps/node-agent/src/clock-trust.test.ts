import { describe, expect, it } from 'vitest';

import {
  CHRONYC_ARGUMENTS,
  CHRONYC_EXECUTABLE,
  CHRONYC_MAX_BUFFER_BYTES,
  CHRONYC_SYNCHRONIZED_LEAP_STATES,
  CHRONYC_TIMEOUT_MS,
  CHRONYC_TRACKING_CSV_FIELD_COUNT,
  CLOCK_TRUST_THRESHOLD_MS,
  CHRONY_LOCAL_REFERENCE_ID,
  ChronyClockTrustProbe,
  evaluateChronyTrackingCsv,
} from './clock-trust';

function trackingCsv(
  overrides: {
    refId?: string;
    name?: string;
    stratum?: string;
    refTime?: string;
    systemTime?: string;
    lastOffset?: string;
    rmsOffset?: string;
    frequency?: string;
    residualFreq?: string;
    skew?: string;
    rootDelay?: string;
    rootDispersion?: string;
    updateInterval?: string;
    leap?: string;
  } = {},
): string {
  return [
    overrides.refId ?? 'CB00710F',
    overrides.name ?? 'ntp.example.test',
    overrides.stratum ?? '3',
    overrides.refTime ?? '1485510557.000000000',
    overrides.systemTime ?? '0.000000000',
    overrides.lastOffset ?? '-0.000006747',
    overrides.rmsOffset ?? '0.000035822',
    overrides.frequency ?? '3.225',
    overrides.residualFreq ?? '-0.000',
    overrides.skew ?? '0.129',
    overrides.rootDelay ?? '0.000000000',
    overrides.rootDispersion ?? '0.000000000',
    overrides.updateInterval ?? '64.2',
    overrides.leap ?? 'Normal',
  ].join(',');
}

describe('evaluateChronyTrackingCsv', () => {
  it('trusts synchronized chrony CSV with estimated error 0', () => {
    expect(evaluateChronyTrackingCsv(`${trackingCsv()}\n`)).toEqual({
      synchronized: true,
      estimatedAbsoluteErrorMs: 0,
      outcome: 'trusted',
      reason: 'trusted',
    });
  });

  it('trusts estimated error 29_999 ms and the 30_000 ms threshold', () => {
    expect(
      evaluateChronyTrackingCsv(
        trackingCsv({ rootDispersion: '29.999000000' }),
      ),
    ).toMatchObject({
      outcome: 'trusted',
      estimatedAbsoluteErrorMs: 29_999,
    });
    expect(
      evaluateChronyTrackingCsv(
        trackingCsv({ rootDispersion: '30.000000000' }),
      ),
    ).toMatchObject({
      outcome: 'trusted',
      estimatedAbsoluteErrorMs: CLOCK_TRUST_THRESHOLD_MS,
    });
  });

  it('rejects estimated error 30_001 ms without rounding down', () => {
    expect(
      evaluateChronyTrackingCsv(
        trackingCsv({ rootDispersion: '30.001000000' }),
      ),
    ).toEqual({
      synchronized: true,
      estimatedAbsoluteErrorMs: 30_001,
      outcome: 'untrusted',
      reason: 'threshold-exceeded',
    });
  });

  it('uses absolute system-time offset and half of root delay', () => {
    expect(
      evaluateChronyTrackingCsv(
        trackingCsv({
          systemTime: '-1.000000000',
          rootDelay: '2.000000000',
          rootDispersion: '0.500000000',
        }),
      ),
    ).toMatchObject({
      outcome: 'trusted',
      estimatedAbsoluteErrorMs: 2_500,
    });
  });

  it('accepts only the documented synchronized leap states from chronyc CSV', () => {
    expect(CHRONYC_SYNCHRONIZED_LEAP_STATES).toEqual([
      'Normal',
      'Insert second',
      'Delete second',
    ]);
    for (const leap of CHRONYC_SYNCHRONIZED_LEAP_STATES) {
      expect(evaluateChronyTrackingCsv(trackingCsv({ leap }))).toMatchObject({
        synchronized: true,
        outcome: 'trusted',
      });
    }
  });

  it('treats unsynchronized leap as untrusted even with a tiny numeric error', () => {
    expect(
      evaluateChronyTrackingCsv(
        trackingCsv({
          stratum: '0',
          systemTime: '0.000000001',
          rootDelay: '0.000000001',
          rootDispersion: '0.000000001',
          leap: 'Not synchronised',
        }),
      ),
    ).toMatchObject({
      synchronized: false,
      outcome: 'untrusted',
      reason: 'unsynchronized',
    });
  });

  it('rejects chrony local/orphan sentinel even with Normal leap and tiny error', () => {
    const assessment = evaluateChronyTrackingCsv(
      trackingCsv({
        refId: '7F7F0101',
        name: 'localhost',
        systemTime: '0.001000000',
        rootDelay: '0.000002000',
        rootDispersion: '0.000500000',
        leap: 'Normal',
      }),
    );
    expect(assessment).toMatchObject({
      outcome: 'untrusted',
      reason: 'local-reference',
    });
    expect(assessment.estimatedAbsoluteErrorMs).toBeCloseTo(1.501);
    expect(JSON.stringify(assessment)).not.toContain(CHRONY_LOCAL_REFERENCE_ID);
    expect(JSON.stringify(assessment)).not.toContain('localhost');
    expect(
      evaluateChronyTrackingCsv(
        trackingCsv({
          refId: '7f7f0101',
          leap: 'Normal',
        }),
      ),
    ).toMatchObject({
      outcome: 'untrusted',
      reason: 'local-reference',
    });
  });

  it('does not treat hostname as a trust signal', () => {
    const assessment = evaluateChronyTrackingCsv(
      trackingCsv({
        refId: 'AABBCCDD',
        name: 'trusted-ntp.internal',
        leap: 'Not synchronised',
      }),
    );
    expect(assessment.outcome).toBe('untrusted');
    expect(assessment.reason).toBe('unsynchronized');
    expect(JSON.stringify(assessment)).not.toContain('trusted-ntp.internal');
    expect(JSON.stringify(assessment)).not.toContain('AABBCCDD');
  });

  it('rejects malformed, incomplete or extra CSV fields', () => {
    expect(evaluateChronyTrackingCsv('')).toMatchObject({
      reason: 'malformed-output',
    });
    expect(evaluateChronyTrackingCsv('Normal\n')).toMatchObject({
      reason: 'malformed-output',
    });
    expect(
      evaluateChronyTrackingCsv(`${trackingCsv()},extra-field\n`),
    ).toMatchObject({ reason: 'malformed-output' });
    expect(
      evaluateChronyTrackingCsv(`${trackingCsv()}\n${trackingCsv()}`),
    ).toMatchObject({ reason: 'malformed-output' });
    expect(CHRONYC_TRACKING_CSV_FIELD_COUNT).toBe(14);
  });

  it('rejects negative, NaN and Infinity uncertainty values', () => {
    expect(
      evaluateChronyTrackingCsv(trackingCsv({ rootDelay: '-0.001000000' })),
    ).toMatchObject({ reason: 'invalid-uncertainty' });
    expect(
      evaluateChronyTrackingCsv(
        trackingCsv({ rootDispersion: '-0.001000000' }),
      ),
    ).toMatchObject({ reason: 'invalid-uncertainty' });
    expect(
      evaluateChronyTrackingCsv(trackingCsv({ systemTime: 'NaN' })),
    ).toMatchObject({ reason: 'invalid-uncertainty' });
    expect(
      evaluateChronyTrackingCsv(trackingCsv({ rootDispersion: 'Infinity' })),
    ).toMatchObject({ reason: 'invalid-uncertainty' });
  });
});

describe('ChronyClockTrustProbe', () => {
  it('uses the approved local chronyc executable and CSV arguments', () => {
    expect(CHRONYC_EXECUTABLE).toBe('/usr/bin/chronyc');
    expect(CHRONYC_ARGUMENTS).toEqual(['-c', 'tracking']);
    expect(CHRONYC_TIMEOUT_MS).toBe(2_000);
    expect(CHRONYC_MAX_BUFFER_BYTES).toBe(4_096);
  });

  it('maps missing executable, timeout and non-zero exit to untrusted', async () => {
    await expect(
      new ChronyClockTrustProbe(async () => {
        throw Object.assign(new Error('spawn /usr/bin/chronyc ENOENT'), {
          code: 'ENOENT',
        });
      }).assess(),
    ).resolves.toMatchObject({
      outcome: 'untrusted',
      reason: 'missing-executable',
    });
    await expect(
      new ChronyClockTrustProbe(async () => {
        throw Object.assign(new Error('Command timed out'), {
          killed: true,
          signal: 'SIGTERM',
        });
      }).assess(),
    ).resolves.toMatchObject({
      outcome: 'untrusted',
      reason: 'timeout',
    });
    await expect(
      new ChronyClockTrustProbe(async () => ({
        status: 1,
        stdout: trackingCsv(),
      })).assess(),
    ).resolves.toMatchObject({
      outcome: 'untrusted',
      reason: 'non-zero-exit',
    });
  });

  it('never copies command output into the thrown probe failure', async () => {
    const leaked = `${trackingCsv({ name: 'secret-ntp.example' })}\nstderr leak`;
    const assessment = await new ChronyClockTrustProbe(async () => {
      throw Object.assign(new Error(leaked), { code: 'ENOENT' });
    }).assess();
    expect(assessment.outcome).toBe('untrusted');
    expect(JSON.stringify(assessment)).not.toContain('secret-ntp.example');
    expect(JSON.stringify(assessment)).not.toContain('stderr leak');
    expect(JSON.stringify(assessment)).not.toContain(leaked);
  });
});
