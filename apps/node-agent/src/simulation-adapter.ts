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

export interface StateFileOperations {
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  openFile(path: string, flags: string, mode?: number): Promise<FileHandle>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const nodeStateFileOperations: StateFileOperations = {
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

export class StateFileSimulationAdapter implements NodeAgentDataPlaneAdapter {
  constructor(
    private readonly statePath: string,
    private readonly files: StateFileOperations = nodeStateFileOperations,
  ) {}

  async apply(
    snapshot: NodeAgentConfigurationSnapshot,
  ): Promise<'applied' | 'already-applied'> {
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
    const snapshotHash = createHash('sha256')
      .update(serializedSnapshot)
      .digest('hex');
    const envelope = await this.readState();
    const current = envelope?.current;
    if (current && current.version > snapshot.desiredConfigVersion) {
      throw new Error('Simulation adapter refuses a version downgrade');
    }
    if (current && current.version === snapshot.desiredConfigVersion) {
      if (current.snapshotHash !== snapshotHash) {
        throw new Error('Simulation adapter detected a version collision');
      }
      await this.confirmDurability();
      return 'already-applied';
    }

    const next: PersistedState = {
      version: snapshot.desiredConfigVersion,
      snapshotHash,
      appliedAt: new Date().toISOString(),
      snapshot,
    };
    await this.writeDurably({ current: next, previous: current ?? null });
    return 'applied';
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
