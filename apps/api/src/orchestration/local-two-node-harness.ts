import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  parseApiEnvironment,
  type ApiEnvironment,
} from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { DataPlaneCredentialService } from './data-plane-credential.service';
import { DeviceAccessRevoker } from './device-access-revoker.service';
import { NodeAccessGrantScheduler } from './node-access-grant-scheduler.service';
import { NodeAccessReconciler } from './node-access-reconciler.service';
import { NodeAgentCredentialService } from './node-agent-credential.service';
import { NodeLifecycleManager } from './node-lifecycle-manager.service';
import { completeNodeSyncJobForHarness } from './node-sync-job-harness';
import { OrchestrationService } from './orchestration.service';

export const LOCAL_TWO_NODE_HARNESS_TELEGRAM_USER_ID = 'local-two-node';
export const LOCAL_TWO_NODE_HARNESS_PLAN_CODE = 'local-two-node';

export const LOCAL_TWO_NODE_SLOTS = {
  a: {
    name: 'local-xray-a',
    defaultPort: 10_443,
    displayName: 'Local A',
    portEnv: 'XRAY_LOCAL_A_PORT',
  },
  b: {
    name: 'local-xray-b',
    defaultPort: 10_444,
    displayName: 'Local B',
    portEnv: 'XRAY_LOCAL_B_PORT',
  },
} as const;

export type LocalTwoNodeSlot = keyof typeof LOCAL_TWO_NODE_SLOTS;

export type LocalTwoNodeHarnessCommand =
  { action: 'provision' } | { action: 'disable'; slot: LocalTwoNodeSlot };

export type LocalTwoNodeHarnessLogger = {
  info(message: string): void;
};

const HARNESS_LEASE_OWNER = 'local-two-node-harness';

export function assertLocalHarnessAllowed(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (environment.NODE_ENV === 'production') {
    throw new Error('Local two-node harness is forbidden in production');
  }
}

export function parseHarnessCommand(
  argv: readonly string[],
): LocalTwoNodeHarnessCommand {
  const [action = 'provision', slot] = argv.filter((entry) => entry !== '--');
  if (action === 'provision') {
    if (slot) {
      throw new Error('provision does not take a node slot');
    }
    return { action: 'provision' };
  }
  if (action !== 'disable') {
    throw new Error('Local two-node harness accepts provision or disable');
  }
  if (slot !== 'a' && slot !== 'b') {
    throw new Error('disable requires node slot a or b');
  }
  return { action: 'disable', slot };
}

export function localTwoNodeHarnessRoot(
  fromDirectory = dirname(__filename),
): string {
  let current = fromDirectory;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    current = dirname(current);
  }
  throw new Error('Local two-node harness could not find the repository root');
}

export async function runLocalTwoNodeHarness(
  command: LocalTwoNodeHarnessCommand,
  environment: NodeJS.ProcessEnv = process.env,
  logger: LocalTwoNodeHarnessLogger = {
    info: (message) => console.info(message),
  },
): Promise<void> {
  assertLocalHarnessAllowed(environment);
  const config = parseApiEnvironment(environment);
  requireLocalHarnessSecrets(config);
  const prisma = new PrismaService(config);
  const dataPlaneCredentials = new DataPlaneCredentialService(config);
  const nodeAccessGrantScheduler = new NodeAccessGrantScheduler(
    prisma,
    dataPlaneCredentials,
  );
  const nodeLifecycleManager = new NodeLifecycleManager(prisma);
  const nodeAccessReconciler = new NodeAccessReconciler(prisma, config);
  const deviceAccessRevoker = new DeviceAccessRevoker(prisma);
  const nodeCredentials = new NodeAgentCredentialService(prisma, config);
  const orchestration = new OrchestrationService(
    prisma,
    nodeAccessGrantScheduler,
    nodeLifecycleManager,
    deviceAccessRevoker,
    nodeAccessReconciler,
  );
  try {
    if (command.action === 'provision') {
      await provisionLocalTwoNodeHarness({
        prisma,
        orchestration,
        nodeCredentials,
        environment: config,
        processEnvironment: environment,
        logger,
      });
      return;
    }
    await disableLocalTwoNodeSlot({
      prisma,
      orchestration,
      slot: command.slot,
      logger,
    });
  } finally {
    await prisma.$disconnect();
  }
}

function requireLocalHarnessSecrets(environment: ApiEnvironment): void {
  for (const key of [
    'SUBSCRIPTION_TOKEN_PEPPER',
    'SUBSCRIPTION_FEED_BASE_URL',
    'DATA_PLANE_CREDENTIAL_PEPPER',
    'NODE_AGENT_CREDENTIAL_PEPPER',
  ] as const) {
    if (!environment[key]) {
      throw new Error(`${key} is required for the local two-node harness`);
    }
  }
}

async function provisionLocalTwoNodeHarness(input: {
  prisma: PrismaService;
  orchestration: OrchestrationService;
  nodeCredentials: NodeAgentCredentialService;
  environment: ApiEnvironment;
  processEnvironment: NodeJS.ProcessEnv;
  logger: LocalTwoNodeHarnessLogger;
}): Promise<void> {
  const root = localTwoNodeHarnessRoot();
  const artifactDirectory = join(root, 'var', 'xray-local');
  await mkdir(artifactDirectory, { recursive: true });
  const token = await readOrCreateSubscriptionToken(artifactDirectory);
  const pepper = input.environment.SUBSCRIPTION_TOKEN_PEPPER as string;
  const feedBaseUrl = input.environment.SUBSCRIPTION_FEED_BASE_URL as string;
  const plan = await input.prisma.plan.upsert({
    where: { code: LOCAL_TWO_NODE_HARNESS_PLAN_CODE },
    update: {},
    create: {
      code: LOCAL_TWO_NODE_HARNESS_PLAN_CODE,
      name: 'Local two-node prototype',
      priceMinor: 1,
      currency: 'RUB',
      deviceLimit: 1,
    },
  });
  const user = await input.prisma.user.upsert({
    where: { telegramUserId: LOCAL_TWO_NODE_HARNESS_TELEGRAM_USER_ID },
    update: {},
    create: { telegramUserId: LOCAL_TWO_NODE_HARNESS_TELEGRAM_USER_ID },
  });
  const existingSubscription = await input.prisma.subscription.findFirst({
    where: { userId: user.id, planId: plan.id },
    select: { id: true },
  });
  if (existingSubscription) {
    await input.prisma.subscription.update({
      where: { id: existingSubscription.id },
      data: {
        status: 'ACTIVE',
        startsAt: new Date('2026-08-01T00:00:00.000Z'),
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
  } else {
    await input.prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: 'ACTIVE',
        startsAt: new Date('2026-08-01T00:00:00.000Z'),
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
  }
  const tokenHash = createHmac('sha256', pepper).update(token).digest('hex');
  const existingDevice = await input.prisma.device.findFirst({
    where: { userId: user.id, status: 'ACTIVE' },
    select: { id: true },
  });
  const device = existingDevice
    ? await input.prisma.device.update({
        where: { id: existingDevice.id },
        data: { subscriptionTokenHash: tokenHash },
        select: { id: true },
      })
    : await input.prisma.device.create({
        data: {
          userId: user.id,
          displayName: 'Local Happ prototype',
          subscriptionTokenHash: tokenHash,
        },
        select: { id: true },
      });

  const nodes: Record<LocalTwoNodeSlot, { id: string; port: number }> = {
    a: { id: '', port: 0 },
    b: { id: '', port: 0 },
  };
  for (const slot of ['a', 'b'] as const) {
    nodes[slot] = await provisionSlot({
      slot,
      deviceId: device.id,
      prisma: input.prisma,
      orchestration: input.orchestration,
      nodeCredentials: input.nodeCredentials,
      processEnvironment: input.processEnvironment,
      apiBaseUrl: `http://${input.environment.API_HOST}:${input.environment.API_PORT}`,
      root,
      logger: input.logger,
    });
  }

  const subscriptionUrl = new URL(`/sub/${token}`, feedBaseUrl).toString();
  await writeSecretFile(
    join(artifactDirectory, 'subscription.url'),
    `${subscriptionUrl}\n`,
  );
  await writeFile(
    join(artifactDirectory, 'harness.json'),
    `${JSON.stringify(
      {
        deviceId: device.id,
        nodes: {
          a: {
            id: nodes.a.id,
            name: LOCAL_TWO_NODE_SLOTS.a.name,
            port: nodes.a.port,
          },
          b: {
            id: nodes.b.id,
            name: LOCAL_TWO_NODE_SLOTS.b.name,
            port: nodes.b.port,
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  input.logger.info(
    'Local two-node harness provisioned two HEALTHY nodes, grants and routes.',
  );
  input.logger.info(
    'Subscription URL written to var/xray-local/subscription.url (gitignored).',
  );
  input.logger.info(
    'Node-agent env files written to var/xray-local/a/agent.env and var/xray-local/b/agent.env.',
  );
  if (!input.environment.SUBSCRIPTION_FEED_RENDERING_ENABLED) {
    input.logger.info(
      'SUBSCRIPTION_FEED_RENDERING_ENABLED is false; set it to true in local .env and restart API before Happ.',
    );
  }
}

async function disableLocalTwoNodeSlot(input: {
  prisma: PrismaService;
  orchestration: OrchestrationService;
  slot: LocalTwoNodeSlot;
  logger: LocalTwoNodeHarnessLogger;
}): Promise<void> {
  const spec = LOCAL_TWO_NODE_SLOTS[input.slot];
  const node = await input.prisma.node.findUnique({
    where: { name: spec.name },
    select: { id: true },
  });
  if (!node) {
    throw new Error(`Local node ${spec.name} has not been provisioned`);
  }
  const disabled = await input.orchestration.disableNode(node.id);
  const grant = await input.prisma.nodeAccessGrant.findFirst({
    where: { nodeId: node.id },
    select: { status: true },
  });
  input.logger.info(
    `Node ${spec.name} is ${disabled.status}; live grants were not revoked (${grant?.status ?? 'none'}).`,
  );
  input.logger.info(
    'This is ordinary disable, not quarantine. Refresh Happ without importing a new URL.',
  );
}

async function provisionSlot(input: {
  slot: LocalTwoNodeSlot;
  deviceId: string;
  prisma: PrismaService;
  orchestration: OrchestrationService;
  nodeCredentials: NodeAgentCredentialService;
  processEnvironment: NodeJS.ProcessEnv;
  apiBaseUrl: string;
  root: string;
  logger: LocalTwoNodeHarnessLogger;
}): Promise<{ id: string; port: number }> {
  const spec = LOCAL_TWO_NODE_SLOTS[input.slot];
  const port = readLocalPort(input.processEnvironment, spec);
  const node = await input.prisma.node.upsert({
    where: { name: spec.name },
    update: {},
    create: {
      name: spec.name,
      provider: 'localhost',
      locationLabel: 'local-xray',
      status: 'HEALTHY',
    },
  });
  if (node.status !== 'HEALTHY' && node.status !== 'DISABLED') {
    throw new Error(`Local node ${spec.name} is not usable for this harness`);
  }
  if (node.status === 'DISABLED') {
    input.logger.info(
      `Node ${spec.name} is already disabled; leaving status unchanged.`,
    );
  }

  const endpoint =
    (await input.prisma.endpoint.findFirst({
      where: { nodeId: node.id, host: '127.0.0.1', port },
    })) ??
    (await input.prisma.endpoint.create({
      data: {
        nodeId: node.id,
        host: '127.0.0.1',
        addressKind: 'IPV4',
        port,
      },
    }));
  const profile =
    (await input.prisma.connectionProfile.findFirst({
      where: { nodeId: node.id, version: 1 },
    })) ??
    (await input.prisma.connectionProfile.create({
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
  const publicConfig = await input.prisma.vlessTcpTlsPublicConfig.findUnique({
    where: { connectionProfileId: profile.id },
    select: { id: true },
  });
  if (!publicConfig) {
    await input.prisma.vlessTcpTlsPublicConfig.create({
      data: {
        connectionProfileId: profile.id,
        tlsServerName: 'localhost',
        displayName: spec.displayName,
      },
    });
  }

  if (node.status === 'HEALTHY') {
    const grant = await input.orchestration.scheduleNodeAccessGrant({
      nodeId: node.id,
      deviceId: input.deviceId,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      syncJobIdempotencyKey: `local-two-node:grant:${input.slot}`,
      outboxEventIdempotencyKey: `local-two-node:grant-outbox:${input.slot}`,
    });
    const published = await input.orchestration.publishConnectionRoute({
      nodeId: node.id,
      endpointId: endpoint.id,
      connectionProfileId: profile.id,
      syncJobIdempotencyKey: `local-two-node:route:${input.slot}`,
      outboxEventIdempotencyKey: `local-two-node:route-outbox:${input.slot}`,
    });
    await ensureJobSucceeded(
      input.prisma,
      grant.nodeSyncJobId,
      input.processEnvironment,
    );
    await ensureJobSucceeded(
      input.prisma,
      published.nodeSyncJobId,
      input.processEnvironment,
    );
  }

  const credential = await input.nodeCredentials.rotate(node.id);
  const instanceDirectory = join(input.root, 'var', 'xray-local', input.slot);
  await mkdir(instanceDirectory, { recursive: true });
  await writeSecretFile(
    join(instanceDirectory, 'agent.env'),
    [
      'NODE_AGENT_ENABLED=true',
      `NODE_AGENT_API_BASE_URL=${input.apiBaseUrl}`,
      `NODE_AGENT_CREDENTIAL=${credential.secret}`,
      'NODE_AGENT_MODE=local-xray',
      `NODE_AGENT_STATE_FILE=../../var/xray-local/${input.slot}/agent-state.json`,
      'NODE_AGENT_XRAY_TEMPLATE_PATH=../../infra/xray-local/config.template.json',
      `NODE_AGENT_XRAY_RUNTIME_CONFIG=../../var/xray-local/${input.slot}/config.json`,
      'NODE_AGENT_XRAY_INBOUND_TAG=vless-tcp-tls',
      '',
    ].join('\n'),
  );
  return { id: node.id, port };
}

async function ensureJobSucceeded(
  prisma: PrismaService,
  nodeSyncJobId: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await completeNodeSyncJobForHarness(
    prisma,
    nodeSyncJobId,
    HARNESS_LEASE_OWNER,
    environment,
  );
}

async function readOrCreateSubscriptionToken(
  artifactDirectory: string,
): Promise<string> {
  const tokenPath = join(artifactDirectory, 'device.token');
  try {
    const existing = (await readFile(tokenPath, 'utf8')).trim();
    if (/^[A-Za-z0-9_-]{43}$/.test(existing)) return existing;
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
  const token = randomBytes(32).toString('base64url');
  await writeSecretFile(tokenPath, `${token}\n`);
  return token;
}

async function writeSecretFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 });
}

function readLocalPort(
  environment: NodeJS.ProcessEnv,
  spec: (typeof LOCAL_TWO_NODE_SLOTS)[LocalTwoNodeSlot],
): number {
  const raw = environment[spec.portEnv];
  if (!raw) return spec.defaultPort;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${spec.portEnv} must be a TCP port`);
  }
  return port;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
