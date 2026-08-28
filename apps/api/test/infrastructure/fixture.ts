import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  HttpNodeAgentControlPlane,
  NodeAgentRunner,
  StateFileSimulationAdapter,
} from '@vpn-platform/node-agent';
import { createHmac, randomUUID } from 'node:crypto';
import { expect } from 'vitest';

import { AppModule } from '../../src/app.module';
import {
  API_ENVIRONMENT,
  parseApiEnvironment,
} from '../../src/config/environment';
import { PrismaService } from '../../src/database/prisma.service';
import type { NodeAgentCredentialService } from '../../src/orchestration/node-agent-credential.service';
import { completeNodeSyncJobForHarness } from '../../src/orchestration/node-sync-job-harness';
import type { OrchestrationService } from '../../src/orchestration/orchestration.service';

export const telegramBotToken = '123456:integration-test-telegram-token';
export const authSessionPepper = 'integration-tests-auth-session-pepper-0001';

export async function createInfrastructureTestApp(): Promise<INestApplication> {
  const testingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(API_ENVIRONMENT)
    .useValue(
      parseApiEnvironment({
        ...process.env,
        TELEGRAM_WEB_APP_BOT_TOKEN: telegramBotToken,
        AUTH_SESSION_PEPPER: authSessionPepper,
        CABINET_ORIGIN: 'https://app.example.test',
        AUTH_PRELAUNCH_RATE_LIMIT_MAX: '3',
        AUTH_CHALLENGE_CLEANUP_BATCH_SIZE: '2',
      }),
    )
    .compile();

  const app = testingModule.createNestApplication(
    new FastifyAdapter({ trustProxy: () => true }),
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

export async function provisionAppliedVlessFeedNode(input: {
  app: INestApplication;
  prisma: PrismaService;
  orchestration: OrchestrationService;
  nodeCredentials: NodeAgentCredentialService;
  suffix: string;
  label: string;
  host: string;
  port: number;
  displayName: string;
  tlsServerName: string;
  deviceId: string;
  statePath: string;
}): Promise<{ nodeId: string; grantId: string; secret: string }> {
  const node = await input.prisma.node.create({
    data: {
      name: `${input.label}-${input.suffix}`,
      provider: 'test',
      locationLabel: 'test',
      status: 'HEALTHY',
    },
  });
  const scheduled = await input.orchestration.scheduleNodeAccessGrant({
    nodeId: node.id,
    deviceId: input.deviceId,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    syncJobIdempotencyKey: `${input.label}-sync-${input.suffix}`,
    outboxEventIdempotencyKey: `${input.label}-outbox-${input.suffix}`,
  });
  await input.prisma.nodeAccessGrant.update({
    where: { id: scheduled.nodeAccessGrantId },
    data: { status: 'ACTIVE' },
  });
  const nodeCredential = await input.nodeCredentials.rotate(node.id);
  await deliverNodeConfig(
    input.app,
    nodeCredential.secret,
    scheduled.nodeSyncJobId,
    input.statePath,
  );
  const endpoint = await input.prisma.endpoint.create({
    data: {
      nodeId: node.id,
      host: input.host,
      addressKind: 'HOSTNAME',
      port: input.port,
    },
  });
  const profile = await input.prisma.connectionProfile.create({
    data: {
      nodeId: node.id,
      profileKey: randomUUID(),
      version: 1,
      status: 'ACTIVE',
      protocolKind: 'VLESS',
      transportKind: 'TCP',
      securityKind: 'TLS',
      clientCompatibility: 'HAPP',
    },
  });
  await input.prisma.vlessTcpTlsPublicConfig.create({
    data: {
      connectionProfileId: profile.id,
      tlsServerName: input.tlsServerName,
      displayName: input.displayName,
    },
  });
  const publishedRoute = await input.orchestration.publishConnectionRoute({
    nodeId: node.id,
    endpointId: endpoint.id,
    connectionProfileId: profile.id,
    syncJobIdempotencyKey: `${input.label}-route-sync-${input.suffix}`,
    outboxEventIdempotencyKey: `${input.label}-route-outbox-${input.suffix}`,
  });
  await deliverNodeConfig(
    input.app,
    nodeCredential.secret,
    publishedRoute.nodeSyncJobId,
    input.statePath,
  );
  return {
    nodeId: node.id,
    grantId: scheduled.nodeAccessGrantId,
    secret: nodeCredential.secret,
  };
}

export async function deliverNodeConfig(
  app: INestApplication,
  credential: string,
  nodeSyncJobId: string,
  statePath: string,
): Promise<void> {
  await completeNodeSyncJobForHarness(
    app.get(PrismaService),
    nodeSyncJobId,
    `integration-delivery-${randomUUID()}`,
    process.env,
  );
  const server = app.getHttpServer() as { listening?: boolean };
  if (!server.listening) await app.listen(0, '127.0.0.1');
  await expect(
    new NodeAgentRunner(
      new HttpNodeAgentControlPlane(await app.getUrl(), credential, 5_000),
      new StateFileSimulationAdapter(statePath),
    ).runCycle(),
  ).resolves.toBe('acknowledged');
}

export async function completeInfrastructureNodeSyncJob(
  prisma: PrismaService,
  nodeSyncJobId: string,
  leaseOwner = `integration-delivery-${randomUUID()}`,
): Promise<void> {
  await completeNodeSyncJobForHarness(
    prisma,
    nodeSyncJobId,
    leaseOwner,
    process.env,
  );
}

export function signedTelegramInitData(
  telegramUserId: string,
  startParam = 'a'.repeat(43),
  queryId = randomUUID(),
  authDateSeconds = Math.floor(Date.now() / 1_000),
): string {
  const parameters = new URLSearchParams({
    auth_date: String(authDateSeconds),
    query_id: queryId,
    user: JSON.stringify({ id: telegramUserId }),
    start_param: startParam,
  });
  const dataCheckString = [...parameters.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData')
    .update(telegramBotToken)
    .digest();
  parameters.set(
    'hash',
    createHmac('sha256', secretKey).update(dataCheckString).digest('hex'),
  );
  return parameters.toString();
}

export function authenticatedNodeId(
  credentials: NodeAgentCredentialService,
  secret: string,
): Promise<string | null> {
  return credentials.withAuthenticatedNodeTransaction(secret, (nodeId) =>
    Promise.resolve(nodeId),
  );
}
