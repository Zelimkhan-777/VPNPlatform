import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { randomUUID } from 'node:crypto';

import {
  parseApiEnvironment,
  type ApiEnvironment,
} from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { DataPlaneCredentialService } from './data-plane-credential.service';
import { NodeAgentCredentialService } from './node-agent-credential.service';
import { OrchestrationService } from './orchestration.service';

export const VPN_FI_NODE_NAME = 'vpn-fi-1';
export const VPN_FI_ARTIFACT_DIRECTORY = 'vpn-fi-01';

export type VpnFiBootstrapLogger = {
  info(message: string): void;
};

export type VpnFiBootstrapInput = {
  endpointHost: string;
  tlsServerName: string;
  nodeAgentApiBaseUrl: string;
  vpnPort: number;
  displayName: string;
};

const BOOTSTRAP_LEASE_OWNER = 'vpn-fi-bootstrap';

export function assertVpnFiBootstrapAllowed(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (environment.NODE_ENV === 'production') {
    throw new Error('vpn-fi bootstrap harness is forbidden in production');
  }
}

export function vpnFiBootstrapRoot(
  fromDirectory = dirname(__filename),
): string {
  let current = fromDirectory;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    current = dirname(current);
  }
  throw new Error('vpn-fi bootstrap could not find the repository root');
}

export function readVpnFiBootstrapInput(
  environment: NodeJS.ProcessEnv = process.env,
): VpnFiBootstrapInput {
  const endpointHost = readRequiredEnv(environment, 'VPN_FI_ENDPOINT_HOST');
  const tlsServerName = readRequiredEnv(environment, 'VPN_FI_TLS_SERVER_NAME');
  const nodeAgentApiBaseUrl = readRequiredEnv(
    environment,
    'VPN_FI_NODE_AGENT_API_BASE_URL',
  );
  assertHttpsApiBaseUrl(nodeAgentApiBaseUrl);
  const vpnPort = readOptionalPort(environment.VPN_FI_VPN_PORT, 443);
  const displayName = environment.VPN_FI_DISPLAY_NAME?.trim() || 'Finland';
  return {
    endpointHost,
    tlsServerName,
    nodeAgentApiBaseUrl,
    vpnPort,
    displayName,
  };
}

export async function runVpnFiBootstrap(
  input: VpnFiBootstrapInput,
  environment: NodeJS.ProcessEnv = process.env,
  logger: VpnFiBootstrapLogger = {
    info: (message) => console.info(message),
  },
): Promise<void> {
  assertVpnFiBootstrapAllowed(environment);
  const config = parseApiEnvironment(environment);
  requireBootstrapSecrets(config);
  const prisma = new PrismaService(config);
  const dataPlaneCredentials = new DataPlaneCredentialService(config);
  const nodeCredentials = new NodeAgentCredentialService(prisma, config);
  const orchestration = new OrchestrationService(
    prisma,
    config,
    dataPlaneCredentials,
  );
  const root = vpnFiBootstrapRoot();
  const artifactDirectory = join(root, 'var', VPN_FI_ARTIFACT_DIRECTORY);

  try {
    const deviceId = await resolveBootstrapDeviceId(root);
    const node = await prisma.node.upsert({
      where: { name: VPN_FI_NODE_NAME },
      update: {
        provider: 'adminvps',
        locationLabel: 'Finland',
      },
      create: {
        name: VPN_FI_NODE_NAME,
        provider: 'adminvps',
        locationLabel: 'Finland',
        status: 'HEALTHY',
      },
    });
    if (node.status !== 'HEALTHY' && node.status !== 'DISABLED') {
      throw new Error(`Node ${VPN_FI_NODE_NAME} is not usable for bootstrap`);
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
        select: { id: true },
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
      await prisma.vlessTcpTlsPublicConfig.update({
        where: { connectionProfileId: profile.id },
        data: {
          tlsServerName: input.tlsServerName,
          displayName: input.displayName,
        },
      });
    }

    if (node.status === 'HEALTHY') {
      const grant = await orchestration.scheduleNodeAccessGrant({
        nodeId: node.id,
        deviceId,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        syncJobIdempotencyKey: 'vpn-fi:bootstrap:grant',
        outboxEventIdempotencyKey: 'vpn-fi:bootstrap:grant-outbox',
      });
      await prisma.nodeAccessGrant.update({
        where: { id: grant.nodeAccessGrantId },
        data: { status: 'ACTIVE' },
      });
      const published = await orchestration.publishConnectionRoute({
        nodeId: node.id,
        endpointId: endpoint.id,
        connectionProfileId: profile.id,
        syncJobIdempotencyKey: 'vpn-fi:bootstrap:route',
        outboxEventIdempotencyKey: 'vpn-fi:bootstrap:route-outbox',
      });
      await ensureJobSucceeded(orchestration, prisma, grant.nodeSyncJobId);
      await ensureJobSucceeded(orchestration, prisma, published.nodeSyncJobId);
    }

    const credential = await nodeCredentials.rotate(node.id);
    await mkdir(artifactDirectory, { recursive: true });
    const reloadCommand =
      environment.VPN_FI_XRAY_RELOAD_COMMAND?.trim() ||
      'docker compose -f infra/docker-compose.vpn-node.yml kill -s HUP xray';
    await writeSecretFile(
      join(artifactDirectory, 'agent.env'),
      [
        'NODE_ENV=production',
        'NODE_AGENT_ENABLED=true',
        `NODE_AGENT_API_BASE_URL=${input.nodeAgentApiBaseUrl}`,
        `NODE_AGENT_CREDENTIAL=${credential.secret}`,
        'NODE_AGENT_MODE=xray',
        'NODE_AGENT_STATE_FILE=../../var/vpn-fi-01/agent-state.json',
        'NODE_AGENT_XRAY_TEMPLATE_PATH=../../infra/xray-production/config.template.json',
        'NODE_AGENT_XRAY_RUNTIME_CONFIG=../../var/vpn-fi-01/xray-config.json',
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
          nodeName: VPN_FI_NODE_NAME,
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
      `Registered ${VPN_FI_NODE_NAME} in control plane and attached route to existing device.`,
    );
    logger.info(
      'Agent env written to var/vpn-fi-01/agent.env (gitignored). Copy to VPS; do not commit or paste secrets.',
    );
    logger.info(
      'Next: place TLS cert/key in var/vpn-fi-01/tls/, run pnpm vpn-node:prepare, deploy compose on VPS, start node-agent.',
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

async function resolveBootstrapDeviceId(root: string): Promise<string> {
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
    'Local device not found. Run pnpm xray:local:harness first so the same subscription URL can include Finland.',
  );
}

async function ensureJobSucceeded(
  orchestration: OrchestrationService,
  prisma: PrismaService,
  nodeSyncJobId: string,
): Promise<void> {
  const job = await prisma.nodeSyncJob.findUniqueOrThrow({
    where: { id: nodeSyncJobId },
    select: { status: true },
  });
  if (job.status === 'SUCCEEDED') return;
  const leaseToken = await orchestration.claimNodeSyncJob(
    nodeSyncJobId,
    BOOTSTRAP_LEASE_OWNER,
  );
  if (!leaseToken) {
    throw new Error('vpn-fi bootstrap could not claim a sync job');
  }
  const completed = await orchestration.completeNodeSyncJob(
    nodeSyncJobId,
    BOOTSTRAP_LEASE_OWNER,
    leaseToken,
  );
  if (!completed) {
    throw new Error('vpn-fi bootstrap could not complete a sync job');
  }
}

function requireBootstrapSecrets(environment: ApiEnvironment): void {
  for (const key of [
    'SUBSCRIPTION_TOKEN_PEPPER',
    'SUBSCRIPTION_FEED_BASE_URL',
    'DATA_PLANE_CREDENTIAL_PEPPER',
    'NODE_AGENT_CREDENTIAL_PEPPER',
  ] as const) {
    if (!environment[key]) {
      throw new Error(`${key} is required for vpn-fi bootstrap`);
    }
  }
}

function readRequiredEnv(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required for vpn-fi bootstrap`);
  }
  return value;
}

function readOptionalPort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('VPN_FI_VPN_PORT must be a TCP port');
  }
  return port;
}

function assertHttpsApiBaseUrl(raw: string): void {
  const url = new URL(raw);
  if (url.protocol !== 'https:') {
    throw new Error(
      'VPN_FI_NODE_AGENT_API_BASE_URL must use HTTPS (tunnel or public API origin reachable from VPS)',
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'VPN_FI_NODE_AGENT_API_BASE_URL must not contain credentials, query, or fragment',
    );
  }
}

async function writeSecretFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
