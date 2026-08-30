import { execFile, type ExecFileException } from 'node:child_process';

export const CLOCK_TRUST_THRESHOLD_MS = 30_000;
export const CHRONYC_EXECUTABLE = '/usr/bin/chronyc';
export const CHRONYC_ARGUMENTS = ['-c', 'tracking'] as const;
export const CHRONYC_TIMEOUT_MS = 2_000;
export const CHRONYC_MAX_BUFFER_BYTES = 4_096;

export const CHRONYC_TRACKING_CSV_FIELD_COUNT = 14;
export const CHRONYC_CSV_REFERENCE_ID_INDEX = 0;
export const CHRONYC_CSV_SYSTEM_TIME_INDEX = 4;
export const CHRONYC_CSV_ROOT_DELAY_INDEX = 10;
export const CHRONYC_CSV_ROOT_DISPERSION_INDEX = 11;
export const CHRONYC_CSV_LEAP_STATUS_INDEX = 13;
export const CHRONY_LOCAL_REFERENCE_ID = '7F7F0101';

export const CHRONYC_SYNCHRONIZED_LEAP_STATES = [
  'Normal',
  'Insert second',
  'Delete second',
] as const;

export type ChronySynchronizedLeapState =
  (typeof CHRONYC_SYNCHRONIZED_LEAP_STATES)[number];

export type ClockTrustReason =
  | 'trusted'
  | 'threshold-exceeded'
  | 'unsynchronized'
  | 'local-reference'
  | 'missing-executable'
  | 'timeout'
  | 'non-zero-exit'
  | 'malformed-output'
  | 'invalid-uncertainty'
  | 'probe-failed';

export interface ClockTrustAssessment {
  synchronized: boolean;
  estimatedAbsoluteErrorMs: number | null;
  outcome: 'trusted' | 'untrusted';
  reason: ClockTrustReason;
}

export interface ClockTrustProbe {
  assess(): Promise<ClockTrustAssessment>;
}

export interface ChronyCommandResult {
  status: number;
  stdout: string;
}

export type ChronyCommandExecutor = () => Promise<ChronyCommandResult>;

const SYNCHRONIZED_LEAP_STATE_SET = new Set<string>(
  CHRONYC_SYNCHRONIZED_LEAP_STATES,
);

export function untrustedClock(
  reason: Exclude<ClockTrustReason, 'trusted'>,
  extras: {
    synchronized?: boolean;
    estimatedAbsoluteErrorMs?: number | null;
  } = {},
): ClockTrustAssessment {
  return {
    synchronized: extras.synchronized ?? false,
    estimatedAbsoluteErrorMs: extras.estimatedAbsoluteErrorMs ?? null,
    outcome: 'untrusted',
    reason,
  };
}

export function evaluateChronyTrackingCsv(
  stdout: string,
): ClockTrustAssessment {
  const line = stdout.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (line === '' || line.includes('\n')) {
    return untrustedClock('malformed-output');
  }

  const fields = line.split(',');
  if (fields.length !== CHRONYC_TRACKING_CSV_FIELD_COUNT) {
    return untrustedClock('malformed-output');
  }

  const leapStatus = fields[CHRONYC_CSV_LEAP_STATUS_INDEX] ?? '';
  const systemTimeOffsetSeconds = parseSeconds(
    fields[CHRONYC_CSV_SYSTEM_TIME_INDEX] ?? '',
  );
  const rootDelaySeconds = parseSeconds(
    fields[CHRONYC_CSV_ROOT_DELAY_INDEX] ?? '',
  );
  const rootDispersionSeconds = parseSeconds(
    fields[CHRONYC_CSV_ROOT_DISPERSION_INDEX] ?? '',
  );

  if (
    systemTimeOffsetSeconds === null ||
    rootDelaySeconds === null ||
    rootDispersionSeconds === null
  ) {
    return untrustedClock('invalid-uncertainty');
  }
  if (rootDelaySeconds < 0 || rootDispersionSeconds < 0) {
    return untrustedClock('invalid-uncertainty');
  }

  const estimatedAbsoluteErrorMs =
    (Math.abs(systemTimeOffsetSeconds) +
      rootDispersionSeconds +
      0.5 * rootDelaySeconds) *
    1_000;
  if (
    !Number.isFinite(estimatedAbsoluteErrorMs) ||
    estimatedAbsoluteErrorMs < 0
  ) {
    return untrustedClock('invalid-uncertainty');
  }

  const synchronized = SYNCHRONIZED_LEAP_STATE_SET.has(leapStatus);
  if (isChronyLocalReferenceId(fields[CHRONYC_CSV_REFERENCE_ID_INDEX])) {
    return untrustedClock('local-reference', {
      synchronized,
      estimatedAbsoluteErrorMs,
    });
  }
  if (!synchronized) {
    return untrustedClock('unsynchronized', {
      synchronized: false,
      estimatedAbsoluteErrorMs,
    });
  }
  if (estimatedAbsoluteErrorMs > CLOCK_TRUST_THRESHOLD_MS) {
    return {
      synchronized: true,
      estimatedAbsoluteErrorMs,
      outcome: 'untrusted',
      reason: 'threshold-exceeded',
    };
  }
  return {
    synchronized: true,
    estimatedAbsoluteErrorMs,
    outcome: 'trusted',
    reason: 'trusted',
  };
}

export class ChronyClockTrustProbe implements ClockTrustProbe {
  constructor(
    private readonly execute: ChronyCommandExecutor = executeLocalChronycTracking,
  ) {}

  async assess(): Promise<ClockTrustAssessment> {
    let result: ChronyCommandResult;
    try {
      result = await this.execute();
    } catch (error) {
      return untrustedClock(classifyChronyExecutionFailure(error));
    }
    if (result.status !== 0) {
      return untrustedClock('non-zero-exit');
    }
    return evaluateChronyTrackingCsv(result.stdout);
  }
}

export function executeLocalChronycTracking(): Promise<ChronyCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      CHRONYC_EXECUTABLE,
      [...CHRONYC_ARGUMENTS],
      {
        timeout: CHRONYC_TIMEOUT_MS,
        maxBuffer: CHRONYC_MAX_BUFFER_BYTES,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(sanitizeExecFileError(error));
          return;
        }
        resolve({
          status: 0,
          stdout: typeof stdout === 'string' ? stdout : '',
        });
      },
    );
  });
}

function isChronyLocalReferenceId(raw: string | undefined): boolean {
  return (raw ?? '').trim().toUpperCase() === CHRONY_LOCAL_REFERENCE_ID;
}

function parseSeconds(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return value;
}

function classifyChronyExecutionFailure(
  error: unknown,
): Exclude<ClockTrustReason, 'trusted'> {
  if (!(error instanceof Error)) return 'probe-failed';
  const failure = error as ChronyProbeFailure;
  if (
    failure.killed === true ||
    failure.signal === 'SIGTERM' ||
    failure.signal === 'SIGKILL' ||
    failure.code === 'ETIMEDOUT'
  ) {
    return 'timeout';
  }
  if (failure.code === 'ENOENT') return 'missing-executable';
  if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return 'malformed-output';
  }
  if (typeof failure.status === 'number' && failure.status !== 0) {
    return 'non-zero-exit';
  }
  if (typeof failure.code === 'number' && failure.code !== 0) {
    return 'non-zero-exit';
  }
  return 'probe-failed';
}

function sanitizeExecFileError(error: ExecFileException): Error {
  const failure = error as ChronyProbeFailure;
  const safe = new Error('chrony clock probe failed');
  const classified = classifyChronyExecutionFailure(error);
  Object.assign(safe, {
    code: failure.code,
    killed: failure.killed,
    signal: failure.signal,
    status: failure.status,
    clockTrustReason: classified,
  });
  return safe;
}

type ChronyProbeFailure = Error & {
  code?: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals | number | null;
  status?: number | null;
};
