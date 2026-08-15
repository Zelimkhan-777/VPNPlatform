import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { dirname } from 'node:path';

export type XrayServableClient = {
  grantId: string;
  credential: string;
};

export interface XrayConfigRuntime {
  applyClients(clients: readonly XrayServableClient[]): Promise<void>;
  inspectClients(): Promise<readonly XrayServableClient[]>;
}

export class InMemoryXrayRuntime implements XrayConfigRuntime {
  private clients: XrayServableClient[] = [];

  constructor(
    private readonly hooks: {
      afterApply?: (
        clients: readonly XrayServableClient[],
      ) => Promise<void> | void;
    } = {},
  ) {}

  async applyClients(clients: readonly XrayServableClient[]): Promise<void> {
    this.clients = clients.map((client) => ({ ...client }));
    await this.hooks.afterApply?.(this.clients);
  }

  async inspectClients(): Promise<readonly XrayServableClient[]> {
    return this.clients.map((client) => ({ ...client }));
  }
}

export type FileXrayRuntimeOptions = {
  templatePath: string;
  runtimeConfigPath: string;
  inboundTag: string;
};

export class FileXrayRuntime implements XrayConfigRuntime {
  constructor(private readonly options: FileXrayRuntimeOptions) {}

  async applyClients(clients: readonly XrayServableClient[]): Promise<void> {
    const template = parseJsonObject(
      await readFile(this.options.templatePath, 'utf8'),
      'template',
    );
    assertTemplateHasNoClientCredentials(template);
    const inbound = findVlessInbound(template, this.options.inboundTag);
    const settings = inbound.settings as Record<string, unknown>;
    settings.clients = [...clients]
      .sort((left, right) => left.grantId.localeCompare(right.grantId))
      .map((client) => ({
        id: client.credential,
        email: client.grantId,
      }));
    const serialized = `${JSON.stringify(template, null, 2)}\n`;
    const existing = await readRuntimeIfPresent(this.options.runtimeConfigPath);
    if (existing === serialized) return;
    await writeRuntimeConfig(this.options.runtimeConfigPath, serialized);
  }

  async inspectClients(): Promise<readonly XrayServableClient[]> {
    const raw = await readRuntimeIfPresent(this.options.runtimeConfigPath);
    if (raw === null) return [];
    const config = parseJsonObject(raw, 'runtime config');
    const inbound = findVlessInbound(config, this.options.inboundTag);
    const settings = inbound.settings as Record<string, unknown>;
    if (!Array.isArray(settings.clients)) return [];
    return settings.clients.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      if (typeof entry.id !== 'string' || typeof entry.email !== 'string') {
        return [];
      }
      return [{ grantId: entry.email, credential: entry.id }];
    });
  }
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Local Xray ${label} is not valid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Local Xray ${label} must be a JSON object`);
  }
  return parsed;
}

function findVlessInbound(
  config: Record<string, unknown>,
  inboundTag: string,
): Record<string, unknown> {
  if (!Array.isArray(config.inbounds)) {
    throw new Error('Local Xray template is missing inbounds');
  }
  const inbound = config.inbounds.find(
    (entry) => isRecord(entry) && entry.tag === inboundTag,
  );
  if (!isRecord(inbound)) {
    throw new Error('Local Xray template is missing the VLESS inbound');
  }
  if (inbound.protocol !== 'vless') {
    throw new Error('Local Xray inbound protocol must be vless');
  }
  if (!isRecord(inbound.settings) || !Array.isArray(inbound.settings.clients)) {
    throw new Error('Local Xray inbound is missing a clients array');
  }
  return inbound;
}

function assertTemplateHasNoClientCredentials(
  config: Record<string, unknown>,
): void {
  if (!Array.isArray(config.inbounds)) return;
  for (const inbound of config.inbounds) {
    if (!isRecord(inbound) || !isRecord(inbound.settings)) continue;
    if (
      Array.isArray(inbound.settings.clients) &&
      inbound.settings.clients.length > 0
    ) {
      throw new Error(
        'Local Xray template must not contain client credentials',
      );
    }
  }
}

async function readRuntimeIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

async function writeRuntimeConfig(
  path: string,
  contents: string,
): Promise<void> {
  const parent = dirname(path);
  const temporaryPath = `${path}.tmp`;
  await mkdir(parent, { recursive: true });
  await rm(temporaryPath, { force: true });
  let temporary: FileHandle | undefined;
  try {
    temporary = await open(temporaryPath, 'wx', 0o600);
    await temporary.writeFile(contents, 'utf8');
    await temporary.sync();
    await temporary.close();
    temporary = undefined;
    await rename(temporaryPath, path);
  } finally {
    if (temporary) await temporary.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
