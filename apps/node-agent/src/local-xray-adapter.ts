import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  nodeAgentConfigurationSnapshotSchema,
  type NodeAgentConfigurationSnapshot,
} from '@vpn-platform/contracts';
import { z } from 'zod';

import type { NodeAgentDataPlaneAdapter } from './agent';
import type { NodeAgentLocalStateReconciler } from './local-state-reconciler';
import {
  ACCESS_CONTROL_ENFORCEMENT_SLA_MS,
  LOCAL_FAIL_CLOSED_RESERVE_MS,
  LOCAL_STATE_INTEGRITY_CHECK_INTERVAL_MS,
} from './security-timing';
import {
  findExpiredXrayClientEnforcementDeadline,
  findNextXrayClientExpiry,
  findRevokedXrayClientEnforcementDeadline,
  findRevokedXrayClientEnforcements,
  findSnapshotRevocationEnforcements,
  selectServableXrayClients,
  type XrayClientRevocationEnforcement,
} from './xray-access';
import type { XrayConfigRuntime, XrayServableClient } from './xray-runtime';

export {
  ACCESS_CONTROL_ENFORCEMENT_SLA_MS as LOCAL_ACCESS_ENFORCEMENT_SLA_MS,
  LOCAL_FAIL_CLOSED_RESERVE_MS,
} from './security-timing';

const persistedStateSchema = z
  .object({
    version: z.number().int().nonnegative(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    appliedAt: z.string().datetime({ offset: true }),
    snapshot: nodeAgentConfigurationSnapshotSchema,
  })
  .strict();

const stateEnvelopeSchema = z
  .object({
    current: persistedStateSchema,
    previous: persistedStateSchema.nullable(),
  })
  .strict();

const stopOnlyLatchSchema = z
  .object({
    formatVersion: z.literal(1),
    targetVersion: z.number().int().nonnegative(),
    enforcementDeadlineAt: z.string().datetime({ offset: true }),
    revokedGrantIds: z.array(z.string().uuid()).min(1),
  })
  .strict()
  .superRefine((latch, context) => {
    const canonicalGrantIds = [...new Set(latch.revokedGrantIds)].sort();
    if (
      canonicalGrantIds.length !== latch.revokedGrantIds.length ||
      canonicalGrantIds.some(
        (grantId, index) => grantId !== latch.revokedGrantIds[index],
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revokedGrantIds'],
        message: 'must contain unique grant IDs in canonical order',
      });
    }
  });

type PersistedState = z.infer<typeof persistedStateSchema>;
type StateEnvelope = z.infer<typeof stateEnvelopeSchema>;
type StopOnlyLatch = z.infer<typeof stopOnlyLatchSchema>;
type StateReadResult =
  | { status: 'valid'; envelope: StateEnvelope }
  | { status: 'missing' }
  | { status: 'corrupt' }
  | { status: 'unreadable' };
type StopOnlyLatchReadResult =
  | { status: 'valid'; latch: StopOnlyLatch }
  | { status: 'missing' }
  | { status: 'corrupt' }
  | { status: 'unreadable' };

export interface LocalXrayStateFileOperations {
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  openFile(
    path: string,
    flags: string,
    mode?: number,
  ): Promise<LocalXrayFileHandle>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface LocalXrayFileHandle {
  writeFile(data: string, encoding: BufferEncoding): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface LocalXrayAdapterLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

const nodeStateFileOperations: LocalXrayStateFileOperations = {
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  read: (path) => readFile(path, 'utf8'),
  openFile: (path, flags, mode) => open(path, flags, mode),
  rename,
  async remove(path) {
    await rm(path, { force: true });
  },
};

export class LocalXrayAdapter
  implements NodeAgentDataPlaneAdapter, NodeAgentLocalStateReconciler
{
  private readonly files: LocalXrayStateFileOperations;
  private readonly now: () => Date;
  private readonly logger: LocalXrayAdapterLogger | undefined;
  private readonly logComponent: string;
  private readonly stateChangeListeners = new Set<() => void>();
  private durabilityIsConfirmed = false;
  private runtimeClientsFingerprint: string | null = null;
  private runtimeIsFailClosed = false;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly statePath: string,
    private readonly runtime: XrayConfigRuntime,
    options: {
      files?: LocalXrayStateFileOperations;
      now?: () => Date;
      logger?: LocalXrayAdapterLogger;
      logComponent?: string;
    } = {},
  ) {
    this.files = options.files ?? nodeStateFileOperations;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
    this.logComponent = options.logComponent ?? 'local-xray';
  }

  async apply(
    snapshot: NodeAgentConfigurationSnapshot,
  ): Promise<'applied' | 'already-applied'> {
    return this.runExclusive(() => this.applySnapshot(snapshot));
  }

  async reconcileConfirmedSnapshot(
    snapshot: NodeAgentConfigurationSnapshot,
  ): Promise<'applied' | 'already-applied'> {
    return this.runExclusive(() => this.applySnapshot(snapshot));
  }

  async enforceSnapshotSecurity(
    snapshot: NodeAgentConfigurationSnapshot,
  ): Promise<void> {
    return this.runExclusive(async () => {
      const existingLatch = await this.readStopOnlyLatch();
      if (existingLatch.status !== 'missing') {
        await this.enterFailClosed('stop-only-latch');
      }
      const state = await this.readState();
      const now = this.now();
      const enforcements =
        state.status === 'valid'
          ? findRevokedXrayClientEnforcements(
              state.envelope.current.snapshot,
              snapshot,
              now,
              ACCESS_CONTROL_ENFORCEMENT_SLA_MS,
            )
          : findSnapshotRevocationEnforcements(
              snapshot,
              ACCESS_CONTROL_ENFORCEMENT_SLA_MS,
            );
      if (enforcements.length === 0) {
        if (state.status !== 'valid') {
          await this.enterFailClosed(state.status);
        }
        return;
      }
      try {
        await this.persistStopOnlyLatch(
          snapshot.desiredConfigVersion,
          enforcements,
        );
      } catch (error) {
        return this.failClosedAndRethrow(error, 'stop-only-latch-write');
      }
      await this.enterFailClosed('uncommanded-revoke-latch');
      this.notifyLocalStateChange();
    });
  }

  async nextLocalReconcileAt(): Promise<number | null> {
    return this.runExclusive(async () => {
      const now = this.now();
      const latch = await this.readStopOnlyLatch();
      if (latch.status !== 'missing') {
        await this.enterFailClosed(`stop-only-latch-${latch.status}`);
        return nextIntegrityCheckAt(now);
      }
      const state = await this.readState();
      if (state.status !== 'valid') {
        await this.enterFailClosed(state.status);
        return nextIntegrityCheckAt(now);
      }
      return nextLocalSecurityCheckAt(state.envelope.current.snapshot, now);
    });
  }

  async reconcileLocalState(): Promise<number | null> {
    return this.runExclusive(async () => {
      const latch = await this.readStopOnlyLatch();
      if (latch.status !== 'missing') {
        await this.enterFailClosed(`stop-only-latch-${latch.status}`);
        return nextIntegrityCheckAt(this.now());
      }
      const state = await this.readState();
      if (state.status !== 'valid') {
        await this.enterFailClosed(state.status);
        return nextIntegrityCheckAt(this.now());
      }
      await this.ensureDurabilityConfirmed();
      const current = state.envelope.current;
      const now = this.now();
      const clients = selectServableXrayClients(current.snapshot, now);
      const clientsFingerprint = fingerprintClients(clients);
      const enforcementDeadlineAt = findExpiredXrayClientEnforcementDeadline(
        current.snapshot,
        now,
        ACCESS_CONTROL_ENFORCEMENT_SLA_MS,
      );
      if (
        !this.runtimeIsFailClosed &&
        shouldFailClosed(enforcementDeadlineAt, now.getTime())
      ) {
        await this.enterFailClosed('expiry-deadline');
      }
      if (
        !this.runtimeIsFailClosed &&
        this.runtimeClientsFingerprint === clientsFingerprint
      ) {
        return nextLocalSecurityCheckAt(current.snapshot, now);
      }
      const wasFailClosed = this.runtimeIsFailClosed;
      try {
        await this.runtime.applyClients(clients, { reloadIfUnchanged: true });
        this.runtimeIsFailClosed = false;
      } catch (error) {
        const failureTime = this.now().getTime();
        if (
          wasFailClosed ||
          shouldFailClosed(enforcementDeadlineAt, failureTime)
        ) {
          return this.failClosedAndRethrow(error, 'expiry-deadline');
        }
        throw error;
      }
      this.runtimeClientsFingerprint = clientsFingerprint;
      this.logLocalReconcile(current.version, clients.length);
      return nextLocalSecurityCheckAt(current.snapshot, now);
    });
  }

  subscribeToLocalStateChanges(listener: () => void): () => void {
    this.stateChangeListeners.add(listener);
    return () => this.stateChangeListeners.delete(listener);
  }

  private async applySnapshot(
    snapshot: NodeAgentConfigurationSnapshot,
  ): Promise<'applied' | 'already-applied'> {
    const snapshotHash = hashNodeAgentSnapshot(snapshot);
    const applyTime = this.now();
    const clients = selectServableXrayClients(snapshot, applyTime);
    const stopOnlyLatch = await this.readStopOnlyLatch();
    if (stopOnlyLatch.status !== 'missing') {
      await this.enterFailClosed(`stop-only-latch-${stopOnlyLatch.status}`);
    }
    const state = await this.readState();
    const current =
      state.status === 'valid' ? state.envelope.current : undefined;
    if (state.status !== 'valid') await this.enterFailClosed(state.status);
    else await this.ensureDurabilityConfirmed();
    if (current && current.version > snapshot.desiredConfigVersion) {
      throw new Error('Local Xray adapter refuses a version downgrade');
    }
    if (current && current.version === snapshot.desiredConfigVersion) {
      if (current.snapshotHash !== snapshotHash) {
        throw new Error('Local Xray adapter detected a version collision');
      }
      const wasFailClosed = this.runtimeIsFailClosed;
      try {
        await this.runtime.applyClients(clients, {
          reloadIfUnchanged: wasFailClosed,
        });
        this.runtimeIsFailClosed = false;
        await this.confirmDurability();
        this.durabilityIsConfirmed = true;
      } catch (error) {
        if (wasFailClosed) {
          return this.failClosedAndRethrow(error, 'durability-failure');
        }
        throw error;
      }
      try {
        await this.clearStopOnlyLatchAfterVerifiedApply(
          snapshot,
          stopOnlyLatch,
        );
      } catch (error) {
        return this.failClosedAndRethrow(error, 'stop-only-latch-clear');
      }
      this.runtimeClientsFingerprint = fingerprintClients(clients);
      this.log(
        'already-applied',
        snapshot.desiredConfigVersion,
        clients.length,
      );
      this.notifyLocalStateChange();
      return 'already-applied';
    }

    const revocationDeadlineAt = current
      ? findRevokedXrayClientEnforcementDeadline(
          current.snapshot,
          snapshot,
          applyTime,
          ACCESS_CONTROL_ENFORCEMENT_SLA_MS,
        )
      : null;
    if (
      !this.runtimeIsFailClosed &&
      shouldFailClosed(revocationDeadlineAt, applyTime.getTime())
    ) {
      await this.enterFailClosed('revoke-deadline');
    }
    const wasFailClosed = this.runtimeIsFailClosed;
    try {
      await this.runtime.applyClients(clients, { reloadIfUnchanged: true });
      this.runtimeIsFailClosed = false;
    } catch (error) {
      if (
        wasFailClosed ||
        state.status !== 'valid' ||
        shouldFailClosed(revocationDeadlineAt, this.now().getTime())
      ) {
        return this.failClosedAndRethrow(
          error,
          state.status === 'valid' ? 'revoke-deadline' : state.status,
        );
      }
      throw error;
    }
    const next: PersistedState = {
      version: snapshot.desiredConfigVersion,
      snapshotHash,
      appliedAt: applyTime.toISOString(),
      snapshot,
    };
    this.durabilityIsConfirmed = false;
    try {
      await this.writeDurably({ current: next, previous: current ?? null });
    } catch (error) {
      return this.failClosedAndRethrow(error, 'durability-failure');
    }
    this.durabilityIsConfirmed = true;
    try {
      await this.clearStopOnlyLatchAfterVerifiedApply(snapshot, stopOnlyLatch);
    } catch (error) {
      return this.failClosedAndRethrow(error, 'stop-only-latch-clear');
    }
    this.runtimeClientsFingerprint = fingerprintClients(clients);
    this.log('applied', snapshot.desiredConfigVersion, clients.length);
    this.notifyLocalStateChange();
    return 'applied';
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private notifyLocalStateChange(): void {
    for (const listener of this.stateChangeListeners) listener();
  }

  private log(
    outcome: 'applied' | 'already-applied',
    version: number,
    clientCount: number,
  ): void {
    this.logger?.info(
      {
        component: this.logComponent,
        outcome,
        version,
        clientCount,
      },
      'Xray snapshot apply finished',
    );
  }

  private logLocalReconcile(version: number, clientCount: number): void {
    this.logger?.info(
      {
        component: this.logComponent,
        outcome: 'local-reconciled',
        version,
        clientCount,
      },
      'Xray local expiry reconcile finished',
    );
  }

  private async enterFailClosed(reason: string): Promise<void> {
    await this.forceFailClosed(reason);
  }

  private async forceFailClosed(reason: string): Promise<void> {
    this.runtimeIsFailClosed = false;
    this.runtimeClientsFingerprint = null;
    await this.runtime.failClosed();
    this.runtimeIsFailClosed = true;
    this.logger?.info(
      {
        component: this.logComponent,
        outcome: 'fail-closed',
        reason,
      },
      'Xray serving entered fail-closed state',
    );
  }

  private async failClosedAndRethrow(
    originalError: unknown,
    reason: string,
  ): Promise<never> {
    try {
      await this.forceFailClosed(reason);
    } catch (failClosedError) {
      throw new AggregateError(
        [originalError, failClosedError],
        'Xray operation failed and fail-closed enforcement also failed',
      );
    }
    throw originalError;
  }

  private async ensureDurabilityConfirmed(): Promise<void> {
    if (this.durabilityIsConfirmed) return;
    try {
      await this.confirmDurability();
      this.durabilityIsConfirmed = true;
    } catch (error) {
      return this.failClosedAndRethrow(error, 'durability-unconfirmed');
    }
  }

  private async readState(): Promise<StateReadResult> {
    let raw: string;
    try {
      raw = await this.files.read(this.statePath);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return { status: 'missing' };
      return { status: 'unreadable' };
    }
    try {
      const envelope = stateEnvelopeSchema.parse(JSON.parse(raw));
      return isStateEnvelopeConsistent(envelope)
        ? { status: 'valid', envelope }
        : { status: 'corrupt' };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        return { status: 'corrupt' };
      }
      throw error;
    }
  }

  private async readStopOnlyLatch(): Promise<StopOnlyLatchReadResult> {
    let raw: string;
    try {
      raw = await this.files.read(this.stopOnlyLatchPath());
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return { status: 'missing' };
      return { status: 'unreadable' };
    }
    try {
      return {
        status: 'valid',
        latch: stopOnlyLatchSchema.parse(JSON.parse(raw)),
      };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        return { status: 'corrupt' };
      }
      throw error;
    }
  }

  private async persistStopOnlyLatch(
    targetVersion: number,
    enforcements: readonly XrayClientRevocationEnforcement[],
  ): Promise<void> {
    const existing = await this.readStopOnlyLatch();
    const existingGrantIds =
      existing.status === 'valid' ? existing.latch.revokedGrantIds : [];
    const existingDeadlineAt =
      existing.status === 'valid'
        ? Date.parse(existing.latch.enforcementDeadlineAt)
        : null;
    const latch: StopOnlyLatch = {
      formatVersion: 1,
      targetVersion:
        existing.status === 'valid'
          ? Math.max(existing.latch.targetVersion, targetVersion)
          : targetVersion,
      enforcementDeadlineAt: new Date(
        enforcements.reduce(
          (earliest, enforcement) => Math.min(earliest, enforcement.deadlineAt),
          existingDeadlineAt ?? Number.POSITIVE_INFINITY,
        ),
      ).toISOString(),
      revokedGrantIds: [
        ...new Set([
          ...existingGrantIds,
          ...enforcements.map((enforcement) => enforcement.grantId),
        ]),
      ].sort(),
    };
    await this.writeJsonDurably(this.stopOnlyLatchPath(), latch);
  }

  private async clearStopOnlyLatchAfterVerifiedApply(
    snapshot: NodeAgentConfigurationSnapshot,
    latchState: StopOnlyLatchReadResult,
  ): Promise<void> {
    if (latchState.status === 'missing') return;
    if (latchState.status !== 'valid') {
      throw new Error('Stop-only latch is not verifiable');
    }
    if (snapshot.desiredConfigVersion < latchState.latch.targetVersion) {
      throw new Error('Applied snapshot does not satisfy stop-only latch');
    }
    const servableGrantIds = new Set(
      selectServableXrayClients(snapshot, this.now()).map(
        (client) => client.grantId,
      ),
    );
    if (
      latchState.latch.revokedGrantIds.some((grantId) =>
        servableGrantIds.has(grantId),
      )
    ) {
      throw new Error('Applied snapshot does not enforce stop-only latch');
    }
    await this.files.remove(this.stopOnlyLatchPath());
    await this.syncParentDirectory(dirname(this.stopOnlyLatchPath()));
  }

  private stopOnlyLatchPath(): string {
    return `${this.statePath}.stop-only.json`;
  }

  private async writeDurably(state: StateEnvelope): Promise<void> {
    await this.writeJsonDurably(this.statePath, state);
  }

  private async writeJsonDurably(path: string, value: unknown): Promise<void> {
    const parent = dirname(path);
    const temporaryPath = `${path}.tmp`;
    await this.files.mkdir(parent);
    await this.files.remove(temporaryPath);

    let temporary: LocalXrayFileHandle | undefined;
    try {
      temporary = await this.files.openFile(temporaryPath, 'wx', 0o600);
      await temporary.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await temporary.sync();
      await temporary.close();
      temporary = undefined;
      await this.files.rename(temporaryPath, path);
      await this.syncParentDirectory(parent);
    } finally {
      if (temporary) await temporary.close().catch(() => undefined);
      await this.files.remove(temporaryPath);
    }
  }

  private async confirmDurability(): Promise<void> {
    let stateFile: LocalXrayFileHandle | undefined;
    try {
      stateFile = await this.files.openFile(this.statePath, 'r+');
      await stateFile.sync();
    } finally {
      if (stateFile) await stateFile.close();
    }
    await this.syncParentDirectory(dirname(this.statePath));
  }

  private async syncParentDirectory(path: string): Promise<void> {
    let directory: LocalXrayFileHandle | undefined;
    try {
      directory = await this.files.openFile(path, 'r');
      await directory.sync();
    } catch (error) {
      if (!isUnsupportedDirectorySync(error)) throw error;
    } finally {
      if (directory) await directory.close();
    }
  }
}

export function hashNodeAgentSnapshot(
  snapshot: NodeAgentConfigurationSnapshot,
): string {
  const serializedSnapshot = JSON.stringify({
    desiredConfigVersion: snapshot.desiredConfigVersion,
    grants: snapshot.grants.map(
      ({
        id,
        status,
        expiresAt,
        desiredVersion,
        revokedAt,
        dataPlaneCredential,
      }) => ({
        id,
        status,
        expiresAt,
        desiredVersion,
        revokedAt,
        dataPlaneCredential,
      }),
    ),
    routes: snapshot.routes,
  });
  return createHash('sha256').update(serializedSnapshot).digest('hex');
}

function isStateEnvelopeConsistent(envelope: StateEnvelope): boolean {
  if (!isPersistedStateConsistent(envelope.current)) return false;
  if (envelope.previous === null) return true;
  return (
    envelope.previous.version < envelope.current.version &&
    isPersistedStateConsistent(envelope.previous)
  );
}

function isPersistedStateConsistent(state: PersistedState): boolean {
  return (
    state.version === state.snapshot.desiredConfigVersion &&
    state.snapshotHash === hashNodeAgentSnapshot(state.snapshot)
  );
}

function fingerprintClients(clients: readonly XrayServableClient[]): string {
  return createHash('sha256').update(JSON.stringify(clients)).digest('hex');
}

function nextIntegrityCheckAt(now: Date): number {
  return now.getTime() + LOCAL_STATE_INTEGRITY_CHECK_INTERVAL_MS;
}

function nextLocalSecurityCheckAt(
  snapshot: NodeAgentConfigurationSnapshot,
  now: Date,
): number {
  const integrityCheckAt = nextIntegrityCheckAt(now);
  const nextExpiryAt = findNextXrayClientExpiry(snapshot, now);
  return nextExpiryAt === null
    ? integrityCheckAt
    : Math.min(integrityCheckAt, nextExpiryAt);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return (
    hasErrorCode(error, 'EINVAL') ||
    hasErrorCode(error, 'ENOTSUP') ||
    hasErrorCode(error, 'EISDIR') ||
    (process.platform === 'win32' && hasErrorCode(error, 'EPERM'))
  );
}

function shouldFailClosed(
  enforcementDeadlineAt: number | null,
  now: number,
): boolean {
  return (
    enforcementDeadlineAt !== null &&
    now >= enforcementDeadlineAt - LOCAL_FAIL_CLOSED_RESERVE_MS
  );
}
