import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { XrayServableClient, XrayServingVerifier } from './xray-runtime';

const execFileAsync = promisify(execFile);

class SafeServingVerificationError extends Error {}

type CommandResult = {
  stdout: string;
};

type CommandExecutor = (
  executable: string,
  arguments_: readonly string[],
) => Promise<CommandResult>;

export type DockerXrayServingVerifierOptions = {
  composeProject?: string;
  composeService?: string;
  apiServer?: string;
  attempts?: number;
  retryDelayMs?: number;
  executeCommand?: CommandExecutor;
  delay?: (milliseconds: number) => Promise<void>;
};

export class DockerXrayServingVerifier implements XrayServingVerifier {
  private readonly composeProject: string;
  private readonly composeService: string;
  private readonly apiServer: string;
  private readonly attempts: number;
  private readonly retryDelayMs: number;
  private readonly executeCommand: CommandExecutor;
  private readonly delay: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly inboundTag: string,
    options: DockerXrayServingVerifierOptions = {},
  ) {
    this.composeProject = options.composeProject ?? 'vpn-platform-vpn-node';
    this.composeService = options.composeService ?? 'xray';
    this.apiServer = options.apiServer ?? '127.0.0.1:10085';
    this.attempts = options.attempts ?? 10;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.executeCommand = options.executeCommand ?? runCommand;
    this.delay = options.delay ?? wait;
  }

  async verifyClients(
    expectedClients: readonly XrayServableClient[],
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        const actualClients = await this.inspectServingClients();
        if (!sameClients(actualClients, expectedClients)) {
          throw new SafeServingVerificationError(
            'Xray serving state does not match the expected access list',
          );
        }
        return;
      } catch (error) {
        lastError = error;
      }
      if (attempt < this.attempts) await this.delay(this.retryDelayMs);
    }

    const message =
      lastError instanceof SafeServingVerificationError
        ? lastError.message
        : 'Xray serving probe failed';
    throw new Error(`Xray serving verification failed: ${message}`);
  }

  private async inspectServingClients(): Promise<XrayServableClient[]> {
    const { stdout: containers } = await this.executeCommand('docker', [
      'ps',
      '--filter',
      `label=com.docker.compose.project=${this.composeProject}`,
      '--filter',
      `label=com.docker.compose.service=${this.composeService}`,
      '--filter',
      'status=running',
      '--format',
      '{{.ID}}',
    ]);
    const containerIds = containers
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (containerIds.length !== 1) {
      throw new SafeServingVerificationError(
        'Xray serving verification requires exactly one running container',
      );
    }

    const { stdout } = await this.executeCommand('docker', [
      'exec',
      containerIds[0]!,
      'xray',
      'api',
      'inbounduser',
      `--server=${this.apiServer}`,
      `--tag=${this.inboundTag}`,
    ]);
    return parseInboundUsers(stdout);
  }
}

function parseInboundUsers(raw: string): XrayServableClient[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SafeServingVerificationError(
      'Xray serving API returned invalid JSON',
    );
  }
  if (!isRecord(parsed)) {
    throw new SafeServingVerificationError(
      'Xray serving API returned an invalid users response',
    );
  }
  if (parsed.users === undefined || parsed.users === null) return [];
  if (!Array.isArray(parsed.users)) {
    throw new SafeServingVerificationError(
      'Xray serving API returned an invalid users response',
    );
  }

  return parsed.users.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.email !== 'string' ||
      !isRecord(entry.account) ||
      typeof entry.account.id !== 'string'
    ) {
      throw new SafeServingVerificationError(
        'Xray serving API returned an invalid user',
      );
    }
    return { grantId: entry.email, credential: entry.account.id };
  });
}

function sameClients(
  actual: readonly XrayServableClient[],
  expected: readonly XrayServableClient[],
): boolean {
  const sortClients = (clients: readonly XrayServableClient[]) =>
    clients
      .map((client) => ({ ...client }))
      .sort(
        (left, right) =>
          left.grantId.localeCompare(right.grantId) ||
          left.credential.localeCompare(right.credential),
      );
  return (
    JSON.stringify(sortClients(actual)) ===
    JSON.stringify(sortClients(expected))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function runCommand(
  executable: string,
  arguments_: readonly string[],
): Promise<CommandResult> {
  try {
    const { stdout } = await execFileAsync(executable, [...arguments_], {
      timeout: 2_000,
    });
    return { stdout };
  } catch {
    throw new SafeServingVerificationError('Xray serving probe command failed');
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
