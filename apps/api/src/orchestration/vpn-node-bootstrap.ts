import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  parseApiEnvironment,
  type ApiEnvironment,
} from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { DataPlaneCredentialService } from './data-plane-credential.service';
import { NodeAccessGrantScheduler } from './node-access-grant-scheduler.service';
import { NodeAgentCredentialService } from './node-agent-credential.service';
import { OrchestrationService } from './orchestration.service';

export type VpnNodeBootstrapDefinition = {
  environmentPrefix: 'VPN_FI' | 'VPN_EU';
  nodeName: string;
  artifactDirectory: string;
  provider: string;
  locationLabel: string;
  defaultDisplayName: string;
  idempotencyPrefix: string;
};

export const VPN_FI_BOOTSTRAP_DEFINITION: VpnNodeBootstrapDefinition = {
  environmentPrefix: 'VPN_FI',
  nodeName: 'vpn-fi-1',
  artifactDirectory: 'vpn-fi-01',
  provider: 'adminvps',
  locationLabel: 'Finland',
  defaultDisplayName: 'Finland',
  idempotencyPrefix: 'vpn-fi',
};

export const VPN_EU_BOOTSTRAP_DEFINITION: VpnNodeBootstrapDefinition = {
  environmentPrefix: 'VPN_EU',
  nodeName: 'vpn-eu-1',
  artifactDirectory: 'vpn-nl-01',
  provider: 'aeza',
  locationLabel: 'Netherlands',
  defaultDisplayName: 'Netherlands',
  idempotencyPrefix: 'vpn-eu',
};

export type VpnNodeBootstrapLogger = {
  info(message: string): void;
};

export type VpnNodeBootstrapInput = {
  endpointHost: string;
  tlsServerName: string;
  nodeAgentApiBaseUrl: string;
  vpnPort: number;
  displayName: string;
};

export type ExistingVpnNodePublicConfig = {
  tlsServerName: string;
  displayName: string;
};

export function assertVpnNodePublicConfigCompatible(
  definition: VpnNodeBootstrapDefinition,
  profileVersion: number,
  existing: ExistingVpnNodePublicConfig,
  input: VpnNodeBootstrapInput,
): void {
  if (
    existing.tlsServerName === input.tlsServerName &&
    existing.displayName === input.displayName
  ) {
    return;
  }
  throw new Error(
    `Connection profile v${profileVersion} for ${definition.nodeName} is immutable; create a new profile version to change TLS or display settings`,
  );
}

export function assertVpnNodeBootstrapAllowed(
  definition: VpnNodeBootstrapDefinition,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (environment.NODE_ENV === 'production') {
    throw new Error(
      `${definition.nodeName} bootstrap harness is forbidden in production`,
    );
  }
}

export function vpnNodeBootstrapRoot(
  fromDirectory = dirname(__filename),
): string {
  let current = fromDirectory;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    current = dirname(current);
  }
  throw new Error('VPN node bootstrap could not find the repository root');
}

export function readVpnNodeBootstrapInput(
  definition: VpnNodeBootstrapDefinition,
  environment: NodeJS.ProcessEnv = process.env,
): VpnNodeBootstrapInput {
  const endpointHostKey = `${definition.environmentPrefix}_ENDPOINT_HOST`;
  const tlsServerNameKey = `${definition.environmentPrefix}_TLS_SERVER_NAME`;
  const apiBaseUrlKey = `${definition.environmentPrefix}_NODE_AGENT_API_BASE_URL`;
  const vpnPortKey = `${definition.environmentPrefix}_VPN_PORT`;
  const displayNameKey = `${definition.environmentPrefix}_DISPLAY_NAME`;
  const endpointHost = readRequiredEnv(
    environment,
    endpointHostKey,
    definition,
  );
  const tlsServerName = readRequiredEnv(
    environment,
    tlsServerNameKey,
    definition,
  );
  const nodeAgentApiBaseUrl = readRequiredEnv(
    environment,
    apiBaseUrlKey,
    definition,
  );
  assertHttpsApiBaseUrl(nodeAgentApiBaseUrl, apiBaseUrlKey);
  const vpnPort = readOptionalPort(environment[vpnPortKey], 443, vpnPortKey);
  const displayName =
    environment[displayNameKey]?.trim() || definition.defaultDisplayName;
  return {
    endpointHost,
    tlsServerName,
    nodeAgentApiBaseUrl,
    vpnPort,
    displayName,
  };
}

export async function runVpnNodeBootstrap(
  definition: VpnNodeBootstrapDefinition,
  input: VpnNodeBootstrapInput,
  environment: NodeJS.ProcessEnv = process.env,
  logger: VpnNodeBootstrapLogger = {
    info: (message) => console.info(message),
  },
): Promise<void> {
  assertVpnNodeBootstrapAllowed(definition, environment);
  const config = parseApiEnvironment(environment);
  requireBootstrapSecrets(config, definition);
  const prisma = new PrismaService(config);
  const dataPlaneCredentials = new DataPlaneCredentialService(config);
  const nodeAccessGrantScheduler = new NodeAccessGrantScheduler(
    prisma,
    dataPlaneCredentials,
  );
  const nodeCredentials = new NodeAgentCredentialService(prisma, config);
  const orchestration = new OrchestrationService(
    prisma,
    config,
    nodeAccessGrantScheduler,
  );
  const root = vpnNodeBootstrapRoot();
  const artifactDirectory = join(root, 'var', definition.artifactDirectory);

  try {
    const deviceId = await resolveBootstrapDeviceId(root, definition);
    const node = await prisma.node.upsert({
      where: { name: definition.nodeName },
      update: {
        provider: definition.provider,
        locationLabel: definition.locationLabel,
      },
      create: {
        name: definition.nodeName,
        provider: definition.provider,
        locationLabel: definition.locationLabel,
        status: 'HEALTHY',
      },
    });
    if (node.status !== 'HEALTHY' && node.status !== 'DISABLED') {
      throw new Error(
        `Node ${definition.nodeName} is not usable for bootstrap`,
      );
    }

    const endpoint =
      (await prisma.endpoint.findFirst({
        where: {
          nodeId: node.id,
          host: input.endpointHost,
          port: input.vpnPort,
        },
      })) ??
      (await prisma.endpoint.create({
        data: {
          nodeId: node.id,
          host: input.endpointHost,
          addressKind: 'IPV4',
          port: input.vpnPort,
        },
      }));

    const profile =
      (await prisma.connectionProfile.findFirst({
        where: { nodeId: node.id, version: 1 },
      })) ??
      (await prisma.connectionProfile.create({
        data: {
          nodeId: node.id,
          profileKey: randomUUID(),
          version: 1,
          protocolKind: 'VLESS',
          transportKind: 'TCP',
          securityKind: 'TLS',
          clientCompatibility: 'HAPP',
        },
      }));

    const existingPublicConfig =
      await prisma.vlessTcpTlsPublicConfig.findUnique({
        where: { connectionProfileId: profile.id },
        select: {
          tlsServerName: true,
          displayName: true,
        },
      });
    if (!existingPublicConfig) {
      await prisma.vlessTcpTlsPublicConfig.create({
        data: {
          connectionProfileId: profile.id,
          tlsServerName: input.tlsServerName,
          displayName: input.displayName,
        },
      });
    } else {
      assertVpnNodePublicConfigCompatible(
        definition,
        profile.version,
        existingPublicConfig,
        input,
      );
    }

    if (node.status === 'HEALTHY') {
      const grant = await orchestration.scheduleNodeAccessGrant({
        nodeId: node.id,
        deviceId,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        syncJobIdempotencyKey: `${definition.idempotencyPrefix}:bootstrap:grant`,
        outboxEventIdempotencyKey: `${definition.idempotencyPrefix}:bootstrap:grant-outbox`,
      });
      await prisma.nodeAccessGrant.update({
        where: { id: grant.nodeAccessGrantId },
        data: { status: 'ACTIVE' },
      });
      const published = await orchestration.publishConnectionRoute({
        nodeId: node.id,
        endpointId: endpoint.id,
        connectionProfileId: profile.id,
        syncJobIdempotencyKey: `${definition.idempotencyPrefix}:bootstrap:route`,
        outboxEventIdempotencyKey: `${definition.idempotencyPrefix}:bootstrap:route-outbox`,
      });
      await ensureJobSucceeded(
        definition,
        orchestration,
        prisma,
        grant.nodeSyncJobId,
      );
      await ensureJobSucceeded(
        definition,
        orchestration,
        prisma,
        published.nodeSyncJobId,
      );
    }

    const credential = await nodeCredentials.rotate(node.id);
    await mkdir(artifactDirectory, { recursive: true });
    const reloadCommandKey = `${definition.environmentPrefix}_XRAY_RELOAD_COMMAND`;
    const reloadCommand =
      environment[reloadCommandKey]?.trim() ||
      `VPN_NODE_STATE_DIRECTORY=${definition.artifactDirectory} docker compose -f ../../infra/docker-compose.vpn-node.yml restart xray`;
    await writeSecretFile(
      join(artifactDirectory, 'agent.env'),
      [
        'NODE_ENV=production',
        'NODE_AGENT_ENABLED=true',
        `NODE_AGENT_API_BASE_URL=${input.nodeAgentApiBaseUrl}`,
        `NODE_AGENT_CREDENTIAL=${credential.secret}`,
        'NODE_AGENT_MODE=xray',
        `NODE_AGENT_STATE_FILE=../../var/${definition.artifactDirectory}/agent-state.json`,
        'NODE_AGENT_XRAY_TEMPLATE_PATH=../../infra/xray-production/config.template.json',
        `NODE_AGENT_XRAY_RUNTIME_CONFIG=../../var/${definition.artifactDirectory}/xray-config.json`,
        'NODE_AGENT_XRAY_INBOUND_TAG=vless-tcp-tls',
        `NODE_AGENT_XRAY_RELOAD_COMMAND=${reloadCommand}`,
        '',
      ].join('\n'),
    );
    await writeFile(
      join(artifactDirectory, 'bootstrap.json'),
      `${JSON.stringify(
        {
          nodeId: node.id,
          nodeName: definition.nodeName,
          deviceId,
          endpoint: {
            host: input.endpointHost,
            port: input.vpnPort,
          },
          tlsServerName: input.tlsServerName,
          displayName: input.displayName,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    logger.info(
      `Registered ${definition.nodeName} in control plane and attached route to existing device.`,
    );
    logger.info(
      `Agent env written to var/${definition.artifactDirectory}/agent.env (gitignored). Copy to VPS; do not commit or paste secrets.`,
    );
    logger.info(
      `Next: place TLS cert/key in var/${definition.artifactDirectory}/tls/, prepare Xray for that state directory, deploy compose on VPS, start node-agent.`,
    );
    if (!config.SUBSCRIPTION_FEED_RENDERING_ENABLED) {
      logger.info(
        'SUBSCRIPTION_FEED_RENDERING_ENABLED is false; enable it in local .env before refreshing Happ.',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function resolveBootstrapDeviceId(
  root: string,
  definition: VpnNodeBootstrapDefinition,
): Promise<string> {
  const harnessPath = join(root, 'var', 'xray-local', 'harness.json');
  try {
    const harness = JSON.parse(await readFile(harnessPath, 'utf8')) as {
      deviceId?: string;
    };
    if (typeof harness.deviceId === 'string' && harness.deviceId.length > 0) {
      return harness.deviceId;
    }
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
  throw new Error(
    `Local device not found. Run pnpm xray:local:harness first so the same subscription URL can include ${definition.defaultDisplayName}.`,
  );
}

async function ensureJobSucceeded(
  definition: VpnNodeBootstrapDefinition,
  orchestration: OrchestrationService,
  prisma: PrismaService,
  nodeSyncJobId: string,
): Promise<void> {
  const job = await prisma.nodeSyncJob.findUniqueOrThrow({
    where: { id: nodeSyncJobId },
    select: { status: true },
  });
  if (job.status === 'SUCCEEDED') return;
  const leaseOwner = `${definition.idempotencyPrefix}-bootstrap`;
  const leaseToken = await orchestration.claimNodeSyncJob(
    nodeSyncJobId,
    leaseOwner,
  );
  if (!leaseToken) {
    throw new Error(
      `${definition.nodeName} bootstrap could not claim a sync job`,
    );
  }
  const completed = await orchestration.completeNodeSyncJob(
    nodeSyncJobId,
    leaseOwner,
    leaseToken,
  );
  if (!completed) {
    throw new Error(
      `${definition.nodeName} bootstrap could not complete a sync job`,
    );
  }
}

function requireBootstrapSecrets(
  environment: ApiEnvironment,
  definition: VpnNodeBootstrapDefinition,
): void {
  for (const key of [
    'SUBSCRIPTION_TOKEN_PEPPER',
    'SUBSCRIPTION_FEED_BASE_URL',
    'DATA_PLANE_CREDENTIAL_PEPPER',
    'NODE_AGENT_CREDENTIAL_PEPPER',
  ] as const) {
    if (!environment[key]) {
      throw new Error(
        `${key} is required for ${definition.nodeName} bootstrap`,
      );
    }
  }
}

function readRequiredEnv(
  environment: NodeJS.ProcessEnv,
  key: string,
  definition: VpnNodeBootstrapDefinition,
): string {
  const value = environment[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required for ${definition.nodeName} bootstrap`);
  }
  return value;
}

function readOptionalPort(
  raw: string | undefined,
  fallback: number,
  key: string,
): number {
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${key} must be a TCP port`);
  }
  return port;
}

function assertHttpsApiBaseUrl(raw: string, key: string): void {
  const url = new URL(raw);
  if (url.protocol !== 'https:') {
    throw new Error(
      `${key} must use HTTPS (tunnel or public API origin reachable from VPS)`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${key} must not contain credentials, query, or fragment`);
  }
}

async function writeSecretFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
