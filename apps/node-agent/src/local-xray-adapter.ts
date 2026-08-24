import { createHash } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  nodeAgentConfigurationSnapshotSchema,
  type NodeAgentConfigurationSnapshot,
} from '@vpn-platform/contracts';
import { z } from 'zod';

import type { NodeAgentDataPlaneAdapter } from './agent';
import type { NodeAgentLocalStateReconciler } from './local-state-reconciler';
import {
  findNextXrayClientExpiry,
  selectServableXrayClients,
} from './xray-access';
import type { XrayConfigRuntime } from './xray-runtime';

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

type PersistedState = z.infer<typeof persistedStateSchema>;
type StateEnvelope = z.infer<typeof stateEnvelopeSchema>;

export interface LocalXrayStateFileOperations {
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  openFile(path: string, flags: string, mode?: number): Promise<FileHandle>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
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
  private lastRuntimeReconciledAt: number | null = null;
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

  async nextLocalReconcileAt(): Promise<number | null> {
    return this.runExclusive(async () => {
      const current = (await this.readState())?.current;
      if (!current) return null;
      const persistedAppliedAt = Date.parse(current.appliedAt);
      const reconciledAt = Math.max(
        persistedAppliedAt,
        this.lastRuntimeReconciledAt ?? persistedAppliedAt,
      );
      return findNextXrayClientExpiry(current.snapshot, new Date(reconciledAt));
    });
  }

  async reconcileLocalState(): Promise<number | null> {
    return this.runExclusive(async () => {
      const current = (await this.readState())?.current;
      if (!current) return null;
      const now = this.now();
      const clients = selectServableXrayClients(current.snapshot, now);
      await this.runtime.applyClients(clients, { reloadIfUnchanged: true });
      this.lastRuntimeReconciledAt = now.getTime();
      const nextExpiryAt = findNextXrayClientExpiry(current.snapshot, now);
      this.logLocalReconcile(current.version, clients.length);
      return nextExpiryAt;
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
    const envelope = await this.readState();
    const current = envelope?.current;
    if (current && current.version > snapshot.desiredConfigVersion) {
      throw new Error('Local Xray adapter refuses a version downgrade');
    }
    if (current && current.version === snapshot.desiredConfigVersion) {
      if (current.snapshotHash !== snapshotHash) {
        throw new Error('Local Xray adapter detected a version collision');
      }
      await this.runtime.applyClients(clients);
      await this.confirmDurability();
      this.lastRuntimeReconciledAt = applyTime.getTime();
      this.log(
        'already-applied',
        snapshot.desiredConfigVersion,
        clients.length,
      );
      this.notifyLocalStateChange();
      return 'already-applied';
    }

    await this.runtime.applyClients(clients, { reloadIfUnchanged: true });
    const next: PersistedState = {
      version: snapshot.desiredConfigVersion,
      snapshotHash,
      appliedAt: applyTime.toISOString(),
      snapshot,
    };
    await this.writeDurably({ current: next, previous: current ?? null });
    this.lastRuntimeReconciledAt = applyTime.getTime();
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

  private async readState(): Promise<StateEnvelope | null> {
    try {
      return stateEnvelopeSchema.parse(
        JSON.parse(await this.files.read(this.statePath)),
      );
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    }
  }

  private async writeDurably(state: StateEnvelope): Promise<void> {
    const parent = dirname(this.statePath);
    const temporaryPath = `${this.statePath}.tmp`;
    await this.files.mkdir(parent);
    await this.files.remove(temporaryPath);

    let temporary: FileHandle | undefined;
    try {
      temporary = await this.files.openFile(temporaryPath, 'wx', 0o600);
      await temporary.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
      await temporary.sync();
      await temporary.close();
      temporary = undefined;
      await this.files.rename(temporaryPath, this.statePath);
      await this.syncParentDirectory(parent);
    } finally {
      if (temporary) await temporary.close().catch(() => undefined);
      await this.files.remove(temporaryPath);
    }
  }

  private async confirmDurability(): Promise<void> {
    let stateFile: FileHandle | undefined;
    try {
      stateFile = await this.files.openFile(this.statePath, 'r+');
      await stateFile.sync();
    } finally {
      if (stateFile) await stateFile.close();
    }
    await this.syncParentDirectory(dirname(this.statePath));
  }

  private async syncParentDirectory(path: string): Promise<void> {
    let directory: FileHandle | undefined;
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
