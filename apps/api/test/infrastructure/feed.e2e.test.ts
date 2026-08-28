import type { INestApplication } from '@nestjs/common';
import { nodeAgentConfigurationSnapshotSchema } from '@vpn-platform/contracts';
import { StateFileSimulationAdapter } from '@vpn-platform/node-agent';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import { API_ENVIRONMENT } from '../../src/config/environment';
import { DataPlaneCredentialService } from '../../src/orchestration/data-plane-credential.service';
import { NodeAgentCredentialService } from '../../src/orchestration/node-agent-credential.service';
import { OrchestrationService } from '../../src/orchestration/orchestration.service';
import { ConnectionRouteSelectionService } from '../../src/subscription-access/connection-route-selection.service';
import { vlessPublicConfigValidationMatrix } from '../../src/subscription-access/vless-public-config.validation-matrix';
import {
  completeInfrastructureNodeSyncJob,
  createInfrastructureTestApp,
  deliverNodeConfig,
  provisionAppliedVlessFeedNode,
  subscriptionTokenPepper,
} from './fixture';

describe('infrastructure feed', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createInfrastructureTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('distinguishes an active entitlement without a ready route from authorization failure', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const token = 'c'.repeat(43);
    let planId: string | undefined;
    let userId: string | undefined;

    try {
      const plan = await prisma.plan.create({
        data: {
          code: `feed-${suffix}`,
          name: 'Feed integration plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 1,
        },
      });
      planId = plan.id;
      const user = await prisma.user.create({
        data: { telegramUserId: `3${suffix.replaceAll('-', '').slice(0, 20)}` },
      });
      userId = user.id;
      await prisma.$transaction([
        prisma.subscription.create({
          data: {
            userId: user.id,
            planId: plan.id,
            status: 'ACTIVE',
            startsAt: new Date('2026-08-01T00:00:00.000Z'),
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          },
        }),
        prisma.device.create({
          data: {
            userId: user.id,
            subscriptionTokenHash: createHmac('sha256', subscriptionTokenPepper)
              .update(token)
              .digest('hex'),
          },
        }),
      ]);

      const response = await request(app.getHttpServer())
        .get(`/sub/${token}`)
        .expect(503);
      expect(response.headers['cache-control']).toBe('no-store');

      await request(app.getHttpServer())
        .get(`/sub/${'d'.repeat(43)}`)
        .expect(401);
    } finally {
      if (userId) {
        await prisma.device.deleteMany({ where: { userId } });
        await prisma.subscription.deleteMany({ where: { userId } });
        await prisma.user.delete({ where: { id: userId } });
      }
      if (planId) {
        await prisma.plan.delete({ where: { id: planId } });
      }
    }
  });

  it('enforces the subscription feed limit through Redis', async () => {
    const token = `${randomUUID().replaceAll('-', '')}${'f'.repeat(11)}`;

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await request(app.getHttpServer())
        .get(`/sub/${token}`)
        .set('x-forwarded-for', '192.0.2.60')
        .expect(401);
    }

    await request(app.getHttpServer())
      .get(`/sub/${token}`)
      .set('x-forwarded-for', '192.0.2.60')
      .expect(429);
  });

  it('renders only an applied VLESS/TCP/TLS/HAPP route and fails closed without leaks', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const nodeCredentials = app.get(NodeAgentCredentialService);
    const dataPlaneCredentials = app.get(DataPlaneCredentialService);
    const environment = app.get(API_ENVIRONMENT) as {
      SUBSCRIPTION_FEED_RENDERING_ENABLED: boolean;
    };
    const suffix = randomUUID();
    const stateDirectory = await mkdtemp(
      join(tmpdir(), 'vpn-route-render-integration-'),
    );
    const statePath = join(stateDirectory, 'state.json');
    const token = `e${suffix.replaceAll('-', '')}${'x'.repeat(10)}`.slice(
      0,
      43,
    );
    const plan = await prisma.plan.create({
      data: {
        code: `render-${suffix}`,
        name: 'Renderer plan',
        priceMinor: 1,
        currency: 'RUB',
        deviceLimit: 1,
      },
    });
    const user = await prisma.user.create({
      data: { telegramUserId: `93${suffix.replaceAll('-', '').slice(0, 20)}` },
    });
    const device = await prisma.device.create({
      data: {
        userId: user.id,
        subscriptionTokenHash: createHmac('sha256', subscriptionTokenPepper)
          .update(token)
          .digest('hex'),
      },
    });
    const node = await prisma.node.create({
      data: {
        name: `render-node-${suffix}`,
        provider: 'test',
        locationLabel: 'test',
        status: 'HEALTHY',
      },
    });
    try {
      await prisma.subscription.create({
        data: {
          userId: user.id,
          planId: plan.id,
          status: 'ACTIVE',
          startsAt: new Date(),
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        },
      });
      const scheduled = await orchestration.scheduleNodeAccessGrant({
        nodeId: node.id,
        deviceId: device.id,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        syncJobIdempotencyKey: `render-sync-${suffix}`,
        outboxEventIdempotencyKey: `render-outbox-${suffix}`,
      });
      await prisma.nodeAccessGrant.update({
        where: { id: scheduled.nodeAccessGrantId },
        data: { status: 'ACTIVE' },
      });
      const nodeCredential = await nodeCredentials.rotate(node.id);
      await deliverNodeConfig(
        app,
        nodeCredential.secret,
        scheduled.nodeSyncJobId,
        statePath,
      );
      const endpoint = await prisma.endpoint.create({
        data: {
          nodeId: node.id,
          host: 'feed.example.test',
          addressKind: 'HOSTNAME',
          port: 443,
        },
      });
      const profile = await prisma.connectionProfile.create({
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
      await prisma.vlessTcpTlsPublicConfig.create({
        data: {
          connectionProfileId: profile.id,
          tlsServerName: 'sni.example.test',
          displayName: 'Happ feed',
        },
      });
      const publishedRoute = await orchestration.publishConnectionRoute({
        nodeId: node.id,
        endpointId: endpoint.id,
        connectionProfileId: profile.id,
        syncJobIdempotencyKey: `render-route-sync-${suffix}`,
        outboxEventIdempotencyKey: `render-route-outbox-${suffix}`,
      });
      const getFeed = () =>
        request(app.getHttpServer())
          .get(`/sub/${token}`)
          .set('x-forwarded-for', '192.0.2.61');
      environment.SUBSCRIPTION_FEED_RENDERING_ENABLED = false;
      await getFeed().expect(503);
      environment.SUBSCRIPTION_FEED_RENDERING_ENABLED = true;
      await getFeed().expect(503);
      await deliverNodeConfig(
        app,
        nodeCredential.secret,
        publishedRoute.nodeSyncJobId,
        statePath,
      );
      const response = await getFeed().expect(200);
      expect(response.headers['content-type']).toMatch(
        /text\/plain; charset=utf-8/,
      );
      expect(response.headers['cache-control']).toBe('no-store');
      const snapshot = await request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${nodeCredential.secret}`)
        .expect(200);
      const credential = snapshot.body.grants.find(
        (grant: { id: string }) => grant.id === scheduled.nodeAccessGrantId,
      ).dataPlaneCredential;
      expect(response.text).toBe(
        `vless://${credential}@feed.example.test:443?encryption=none&security=tls&type=tcp&sni=sni.example.test#Happ%20feed`,
      );
      expect(snapshot.body.routes).toEqual([
        {
          activationVersion: publishedRoute.activationVersion,
          endpoint: {
            id: endpoint.id,
            host: 'feed.example.test',
            addressKind: 'HOSTNAME',
            port: 443,
            priority: 0,
          },
          profile: {
            id: profile.id,
            profileKey: profile.profileKey,
            version: 1,
            protocolKind: 'VLESS',
            transportKind: 'TCP',
            securityKind: 'TLS',
            clientCompatibility: 'HAPP',
            priority: 0,
          },
          publicConfig: {
            kind: 'VLESS_TCP_TLS',
            tlsServerName: 'sni.example.test',
            displayName: 'Happ feed',
          },
        },
      ]);
      expect(
        JSON.stringify(
          await prisma.outboxEvent.findUniqueOrThrow({
            where: { id: scheduled.outboxEventId },
          }),
        ),
      ).not.toContain(credential);
      expect(
        JSON.stringify(
          await prisma.auditEvent.findMany({
            where: { entityId: scheduled.nodeAccessGrantId },
          }),
        ),
      ).not.toContain(credential);
      const expectUnavailable = async () => {
        await getFeed().expect(503);
      };
      const restoreAppliedGrant = () =>
        prisma.nodeAccessGrant.update({
          where: { id: scheduled.nodeAccessGrantId },
          data: {
            status: 'ACTIVE',
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
            desiredVersion: scheduled.targetVersion,
            appliedVersion: scheduled.targetVersion,
            dataPlaneCredentialDerivationVersion: 1,
          },
        });

      await prisma.nodeAccessGrant.update({
        where: { id: scheduled.nodeAccessGrantId },
        data: { status: 'PENDING' },
      });
      await expectUnavailable();
      await restoreAppliedGrant();
      await prisma.nodeAccessGrant.update({
        where: { id: scheduled.nodeAccessGrantId },
        data: { appliedVersion: 0 },
      });
      await expectUnavailable();
      await restoreAppliedGrant();
      await prisma.nodeAccessGrant.update({
        where: { id: scheduled.nodeAccessGrantId },
        data: { expiresAt: new Date('2000-01-01T00:00:00.000Z') },
      });
      await expectUnavailable();
      await restoreAppliedGrant();
      await prisma.nodeAccessGrant.update({
        where: { id: scheduled.nodeAccessGrantId },
        data: { dataPlaneCredentialDerivationVersion: null },
      });
      await expectUnavailable();
      await restoreAppliedGrant();
      await prisma.nodeAccessGrant.update({
        where: { id: scheduled.nodeAccessGrantId },
        data: { dataPlaneCredentialHash: `mismatch-${suffix}` },
      });
      await expectUnavailable();
      await prisma.nodeAccessGrant.update({
        where: { id: scheduled.nodeAccessGrantId },
        data: {
          dataPlaneCredentialHash: dataPlaneCredentials.hash(credential),
        },
      });
      await prisma.connectionProfile.update({
        where: { id: profile.id },
        data: { status: 'DISABLED' },
      });
      await expectUnavailable();
      await prisma.connectionProfile.update({
        where: { id: profile.id },
        data: { status: 'ACTIVE' },
      });
      await expect(
        prisma.connectionProfile.update({
          where: { id: profile.id },
          data: { securityKind: 'REALITY' },
        }),
      ).rejects.toThrow();
      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'DRAINING' },
      });
      await expectUnavailable();
      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'HEALTHY' },
      });
      await expect(
        prisma.vlessTcpTlsPublicConfig.delete({
          where: { connectionProfileId: profile.id },
        }),
      ).rejects.toThrow();

      const capturedConsole: string[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => {
        capturedConsole.push(args.map(String).join(' '));
      });
      const error = vi.spyOn(console, 'error').mockImplementation((...args) => {
        capturedConsole.push(args.map(String).join(' '));
      });
      try {
        const denied = await request(app.getHttpServer())
          .get(`/sub/${'z'.repeat(43)}`)
          .set('x-forwarded-for', '192.0.2.61')
          .expect(401);
        expect(denied.headers['set-cookie']).toBeUndefined();
        expect(denied.text).not.toContain(token);
        expect(denied.text).not.toContain(credential);
        expect(denied.text).not.toContain(response.text);
        await prisma.device.update({
          where: { id: device.id },
          data: { status: 'REVOKED', revokedAt: new Date() },
        });
        const disabledDevice = await getFeed().expect(401);
        await prisma.device.update({
          where: { id: device.id },
          data: { status: 'ACTIVE', revokedAt: null },
        });
        await prisma.subscription.updateMany({
          where: { userId: user.id },
          data: {
            startsAt: new Date('1999-01-01T00:00:00.000Z'),
            expiresAt: new Date('2000-01-01T00:00:00.000Z'),
          },
        });
        const expiredSubscription = await getFeed().expect(401);
        expect(disabledDevice.text).toBe(expiredSubscription.text);
        await prisma.subscription.updateMany({
          where: { userId: user.id },
          data: {
            startsAt: new Date(),
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          },
        });
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
      const artifacts = JSON.stringify({
        audit: await prisma.auditEvent.findMany({
          where: { entityId: scheduled.nodeAccessGrantId },
        }),
        outbox: await prisma.outboxEvent.findMany({
          where: { aggregateId: scheduled.nodeAccessGrantId },
        }),
        jobs: await prisma.nodeSyncJob.findMany({
          where: { nodeAccessGrantId: scheduled.nodeAccessGrantId },
        }),
      });
      const dataPlanePepper = (
        app.get(API_ENVIRONMENT) as { DATA_PLANE_CREDENTIAL_PEPPER: string }
      ).DATA_PLANE_CREDENTIAL_PEPPER;
      for (const secret of [
        token,
        dataPlanePepper,
        credential,
        response.text,
      ]) {
        expect(artifacts).not.toContain(secret);
        expect(capturedConsole.join('\n')).not.toContain(secret);
      }
      await prisma.nodeAccessGrant.update({
        where: { id: scheduled.nodeAccessGrantId },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      await expectUnavailable();
      await prisma.endpoint.update({
        where: { id: endpoint.id },
        data: { status: 'DISABLED' },
      });
      await getFeed().expect(503);
    } finally {
      environment.SUBSCRIPTION_FEED_RENDERING_ENABLED = false;
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it('keeps two applied routes in the same token feed and drops only a disabled node', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const nodeCredentials = app.get(NodeAgentCredentialService);
    const environment = app.get(API_ENVIRONMENT) as {
      SUBSCRIPTION_FEED_RENDERING_ENABLED: boolean;
    };
    const suffix = randomUUID();
    const stateDirectory = await mkdtemp(
      join(tmpdir(), 'vpn-two-node-feed-integration-'),
    );
    const token = `t${suffix.replaceAll('-', '')}${'y'.repeat(10)}`.slice(
      0,
      43,
    );
    const plan = await prisma.plan.create({
      data: {
        code: `two-node-${suffix}`,
        name: 'Two node plan',
        priceMinor: 1,
        currency: 'RUB',
        deviceLimit: 1,
      },
    });
    const user = await prisma.user.create({
      data: { telegramUserId: `94${suffix.replaceAll('-', '').slice(0, 20)}` },
    });
    const device = await prisma.device.create({
      data: {
        userId: user.id,
        subscriptionTokenHash: createHmac('sha256', subscriptionTokenPepper)
          .update(token)
          .digest('hex'),
      },
    });
    await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: 'ACTIVE',
        startsAt: new Date(),
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    environment.SUBSCRIPTION_FEED_RENDERING_ENABLED = true;
    const capturedConsole: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      capturedConsole.push(args.map(String).join(' '));
    });
    const error = vi.spyOn(console, 'error').mockImplementation((...args) => {
      capturedConsole.push(args.map(String).join(' '));
    });
    try {
      const first = await provisionAppliedVlessFeedNode({
        app,
        prisma,
        orchestration,
        nodeCredentials,
        suffix,
        label: 'two-node-a',
        host: 'node-a.example.test',
        port: 443,
        displayName: 'Node A',
        tlsServerName: 'sni-a.example.test',
        deviceId: device.id,
        statePath: join(stateDirectory, 'a.json'),
      });
      const second = await provisionAppliedVlessFeedNode({
        app,
        prisma,
        orchestration,
        nodeCredentials,
        suffix,
        label: 'two-node-b',
        host: 'node-b.example.test',
        port: 443,
        displayName: 'Node B',
        tlsServerName: 'sni-b.example.test',
        deviceId: device.id,
        statePath: join(stateDirectory, 'b.json'),
      });
      const getFeed = () =>
        request(app.getHttpServer())
          .get(`/sub/${token}`)
          .set('x-forwarded-for', '192.0.2.62');
      const initial = await getFeed().expect(200);
      const initialLines = initial.text.split('\n');
      expect(initialLines).toHaveLength(2);
      expect(new Set(initialLines).size).toBe(2);
      expect(initial.text).toContain('node-a.example.test');
      expect(initial.text).toContain('node-b.example.test');

      await expect(
        orchestration.disableNode(first.nodeId),
      ).resolves.toMatchObject({ status: 'DISABLED' });
      await expect(
        orchestration.disableNode(first.nodeId),
      ).resolves.toMatchObject({ status: 'DISABLED' });
      await expect(
        prisma.nodeAccessGrant.findUniqueOrThrow({
          where: { id: first.grantId },
        }),
      ).resolves.toMatchObject({ status: 'ACTIVE' });
      await expect(
        orchestration.scheduleNodeAccessGrant({
          nodeId: first.nodeId,
          deviceId: device.id,
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          syncJobIdempotencyKey: `two-node-disabled-new-${suffix}`,
          outboxEventIdempotencyKey: `two-node-disabled-new-outbox-${suffix}`,
        }),
      ).rejects.toThrow('Node access cannot be scheduled for this node');

      const afterDisable = await getFeed().expect(200);
      expect(afterDisable.text.split('\n')).toEqual([
        initialLines.find((line) => line.includes('node-b.example.test')),
      ]);
      expect(afterDisable.text).not.toContain('node-a.example.test');

      const quarantined = await orchestration.quarantineNode({
        nodeId: first.nodeId,
        syncJobIdempotencyKey: `two-node-quarantine-${suffix}`,
        outboxEventIdempotencyKey: `two-node-quarantine-outbox-${suffix}`,
      });
      expect(quarantined.nodeSyncJobId).toEqual(expect.any(String));
      await expect(
        prisma.nodeAccessGrant.findUniqueOrThrow({
          where: { id: first.grantId },
        }),
      ).resolves.toMatchObject({ status: 'REVOKED' });
      const afterQuarantine = await getFeed().expect(200);
      expect(afterQuarantine.text).toBe(afterDisable.text);
      await expect(orchestration.disableNode(first.nodeId)).rejects.toThrow(
        'Node cannot be disabled',
      );
      await expect(
        prisma.nodeAccessGrant.findUniqueOrThrow({
          where: { id: second.grantId },
        }),
      ).resolves.toMatchObject({ status: 'ACTIVE' });

      const denied = await request(app.getHttpServer())
        .get(`/sub/${'z'.repeat(43)}`)
        .set('x-forwarded-for', '192.0.2.62')
        .expect(401);
      expect(denied.text).not.toContain(token);
      expect(denied.text).not.toContain(initial.text);
      for (const secret of [token, first.secret, second.secret, initial.text]) {
        expect(capturedConsole.join('\n')).not.toContain(secret);
      }
    } finally {
      warn.mockRestore();
      error.mockRestore();
      environment.SUBSCRIPTION_FEED_RENDERING_ENABLED = false;
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it('keeps public config immutable and serializes parent/child changes', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const node = await prisma.node.create({
      data: {
        name: `public-config-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
      },
    });
    const profileKey = randomUUID();
    const profile = await prisma.connectionProfile.create({
      data: {
        nodeId: node.id,
        profileKey,
        version: 1,
        protocolKind: 'VLESS',
        transportKind: 'TCP',
        securityKind: 'TLS',
        clientCompatibility: 'HAPP',
      },
    });
    const config = await prisma.vlessTcpTlsPublicConfig.create({
      data: {
        connectionProfileId: profile.id,
        tlsServerName: 'immutable.example.test',
        displayName: 'Berlin route',
      },
    });

    await expect(
      prisma.vlessTcpTlsPublicConfig.update({
        where: { id: config.id },
        data: { tlsServerName: 'replacement.example.test' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.vlessTcpTlsPublicConfig.delete({ where: { id: config.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.vlessTcpTlsPublicConfig.delete({
          where: { id: config.id },
        });
        await transaction.vlessTcpTlsPublicConfig.create({
          data: {
            connectionProfileId: profile.id,
            tlsServerName: 'replacement.example.test',
            displayName: 'Replacement',
          },
        });
      }),
    ).rejects.toThrow();
    await expect(
      prisma.connectionProfile.update({
        where: { id: profile.id },
        data: { securityKind: 'REALITY' },
      }),
    ).rejects.toThrow();

    const nextProfile = await prisma.connectionProfile.create({
      data: {
        nodeId: node.id,
        profileKey,
        version: 2,
        protocolKind: 'VLESS',
        transportKind: 'TCP',
        securityKind: 'TLS',
        clientCompatibility: 'HAPP',
      },
    });
    await expect(
      prisma.vlessTcpTlsPublicConfig.create({
        data: {
          connectionProfileId: nextProfile.id,
          tlsServerName: 'next.example.test',
          displayName: 'Next version',
        },
      }),
    ).resolves.toMatchObject({ connectionProfileId: nextProfile.id });

    const parentFirst = await prisma.connectionProfile.create({
      data: {
        nodeId: node.id,
        version: 1,
        protocolKind: 'VLESS',
        transportKind: 'TCP',
        securityKind: 'TLS',
        clientCompatibility: 'HAPP',
      },
    });
    const parentMutation = prisma.$transaction(async (transaction) => {
      await transaction.connectionProfile.update({
        where: { id: parentFirst.id },
        data: { securityKind: 'REALITY' },
      });
      await transaction.$executeRaw`SELECT pg_sleep(0.1)`;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(
      prisma.vlessTcpTlsPublicConfig.create({
        data: {
          connectionProfileId: parentFirst.id,
          tlsServerName: 'parent-first.example.test',
          displayName: 'Parent first',
        },
      }),
    ).rejects.toThrow();
    await parentMutation;

    const childFirst = await prisma.connectionProfile.create({
      data: {
        nodeId: node.id,
        version: 1,
        protocolKind: 'VLESS',
        transportKind: 'TCP',
        securityKind: 'TLS',
        clientCompatibility: 'HAPP',
      },
    });
    const childInsert = prisma.$transaction(async (transaction) => {
      await transaction.vlessTcpTlsPublicConfig.create({
        data: {
          connectionProfileId: childFirst.id,
          tlsServerName: 'child-first.example.test',
          displayName: 'Child first',
        },
      });
      await transaction.$executeRaw`SELECT pg_sleep(0.1)`;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(
      prisma.connectionProfile.update({
        where: { id: childFirst.id },
        data: { securityKind: 'REALITY' },
      }),
    ).rejects.toThrow();
    await childInsert;
  });

  it('keeps every direct route eligibility transition closed until a rollout', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const suffix = randomUUID();
    const node = await prisma.node.create({
      data: {
        name: `route-transition-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'HEALTHY',
      },
    });
    const endpoint = await prisma.endpoint.create({
      data: {
        nodeId: node.id,
        host: 'transition.example.test',
        addressKind: 'HOSTNAME',
        port: 443,
        status: 'DISABLED',
      },
    });
    const draftProfile = await prisma.connectionProfile.create({
      data: {
        nodeId: node.id,
        version: 1,
        status: 'DRAFT',
        protocolKind: 'VLESS',
        transportKind: 'TCP',
        securityKind: 'TLS',
        clientCompatibility: 'HAPP',
      },
    });
    await prisma.vlessTcpTlsPublicConfig.create({
      data: {
        connectionProfileId: draftProfile.id,
        tlsServerName: 'transition.example.test',
        displayName: 'Transition route',
      },
    });
    await prisma.endpointConnectionProfile.create({
      data: {
        endpointId: endpoint.id,
        connectionProfileId: draftProfile.id,
        nodeId: node.id,
      },
    });

    await prisma.endpoint.update({
      where: { id: endpoint.id },
      data: { status: 'ACTIVE' },
    });
    await prisma.connectionProfile.update({
      where: { id: draftProfile.id },
      data: { status: 'ACTIVE' },
    });
    await expect(
      prisma.endpointConnectionProfile.findUniqueOrThrow({
        where: {
          endpointId_connectionProfileId: {
            endpointId: endpoint.id,
            connectionProfileId: draftProfile.id,
          },
        },
        select: { activationVersion: true },
      }),
    ).resolves.toEqual({ activationVersion: null });
    await expect(
      prisma.node.findUniqueOrThrow({
        where: { id: node.id },
        select: { desiredConfigVersion: true },
      }),
    ).resolves.toEqual({ desiredConfigVersion: 0 });

    const lateProfile = await prisma.connectionProfile.create({
      data: {
        nodeId: node.id,
        version: 1,
        status: 'ACTIVE',
        protocolKind: 'VLESS',
        transportKind: 'TCP',
        securityKind: 'TLS',
        clientCompatibility: 'HAPP',
      },
    });
    await prisma.endpointConnectionProfile.create({
      data: {
        endpointId: endpoint.id,
        connectionProfileId: lateProfile.id,
        nodeId: node.id,
      },
    });
    await prisma.vlessTcpTlsPublicConfig.create({
      data: {
        connectionProfileId: lateProfile.id,
        tlsServerName: 'late.example.test',
        displayName: 'Late config route',
      },
    });
    await expect(
      prisma.endpointConnectionProfile.findUniqueOrThrow({
        where: {
          endpointId_connectionProfileId: {
            endpointId: endpoint.id,
            connectionProfileId: lateProfile.id,
          },
        },
        select: { activationVersion: true },
      }),
    ).resolves.toEqual({ activationVersion: null });
    await expect(
      prisma.endpointConnectionProfile.update({
        where: {
          endpointId_connectionProfileId: {
            endpointId: endpoint.id,
            connectionProfileId: lateProfile.id,
          },
        },
        data: { activationVersion: 1 },
      }),
    ).rejects.toThrow('matching sync job');
    const extraPayloadJob = await prisma.nodeSyncJob.create({
      data: {
        nodeId: node.id,
        routeEndpointId: endpoint.id,
        routeConnectionProfileId: lateProfile.id,
        targetVersion: 99,
        idempotencyKey: `route-extra-outbox-${suffix}`,
      },
    });
    await prisma.outboxEvent.create({
      data: {
        topic: 'node-sync.requested',
        aggregateType: 'ConnectionRoute',
        aggregateId: endpoint.id,
        payload: {
          routeEndpointId: endpoint.id,
          routeConnectionProfileId: lateProfile.id,
          nodeSyncJobId: extraPayloadJob.id,
          targetVersion: 99,
          unexpected: true,
        },
        idempotencyKey: `route-extra-outbox-event-${suffix}`,
      },
    });
    await expect(
      prisma.endpointConnectionProfile.update({
        where: {
          endpointId_connectionProfileId: {
            endpointId: endpoint.id,
            connectionProfileId: lateProfile.id,
          },
        },
        data: { activationVersion: 99 },
      }),
    ).rejects.toThrow('matching outbox event');
    const deliveredBeforeActivationJob = await prisma.nodeSyncJob.create({
      data: {
        nodeId: node.id,
        routeEndpointId: endpoint.id,
        routeConnectionProfileId: lateProfile.id,
        targetVersion: 100,
        idempotencyKey: `route-delivered-before-activation-${suffix}`,
      },
    });
    await prisma.outboxEvent.create({
      data: {
        topic: 'node-sync.requested',
        aggregateType: 'ConnectionRoute',
        aggregateId: endpoint.id,
        payload: {
          routeEndpointId: endpoint.id,
          routeConnectionProfileId: lateProfile.id,
          nodeSyncJobId: deliveredBeforeActivationJob.id,
          targetVersion: 100,
        },
        idempotencyKey: `route-delivered-before-activation-outbox-${suffix}`,
      },
    });
    await prisma.nodeConfigDelivery.create({
      data: {
        nodeId: node.id,
        nodeSyncJobId: deliveredBeforeActivationJob.id,
        targetVersion: 100,
        snapshotHash: 'b'.repeat(64),
      },
    });
    await expect(
      prisma.endpointConnectionProfile.update({
        where: {
          endpointId_connectionProfileId: {
            endpointId: endpoint.id,
            connectionProfileId: lateProfile.id,
          },
        },
        data: { activationVersion: 100 },
      }),
    ).rejects.toThrow('already delivered');

    const firstPublication = await orchestration.publishConnectionRoute({
      nodeId: node.id,
      endpointId: endpoint.id,
      connectionProfileId: lateProfile.id,
      syncJobIdempotencyKey: `mixed-route-first-sync-${suffix}`,
      outboxEventIdempotencyKey: `mixed-route-first-outbox-${suffix}`,
    });
    const secondProfile = await prisma.connectionProfile.create({
      data: {
        nodeId: node.id,
        version: 1,
        status: 'ACTIVE',
        protocolKind: 'VLESS',
        transportKind: 'TCP',
        securityKind: 'TLS',
        clientCompatibility: 'HAPP',
      },
    });
    await prisma.vlessTcpTlsPublicConfig.create({
      data: {
        connectionProfileId: secondProfile.id,
        tlsServerName: 'mixed.example.test',
        displayName: 'Mixed idempotency route',
      },
    });
    const secondPublication = await orchestration.publishConnectionRoute({
      nodeId: node.id,
      endpointId: endpoint.id,
      connectionProfileId: secondProfile.id,
      syncJobIdempotencyKey: `mixed-route-second-sync-${suffix}`,
      outboxEventIdempotencyKey: `mixed-route-second-outbox-${suffix}`,
    });
    await expect(
      orchestration.publishConnectionRoute({
        nodeId: node.id,
        endpointId: endpoint.id,
        connectionProfileId: lateProfile.id,
        syncJobIdempotencyKey: `mixed-route-first-sync-${suffix}`,
        outboxEventIdempotencyKey: `mixed-route-second-outbox-${suffix}`,
      }),
    ).rejects.toThrow('Idempotency key does not match the requested route');
    expect(firstPublication.nodeSyncJobId).not.toBe(
      secondPublication.nodeSyncJobId,
    );
  });

  it('delivers route activation through the real snapshot and serializes retries and acknowledgements', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const nodeCredentials = app.get(NodeAgentCredentialService);
    const routes = app.get(ConnectionRouteSelectionService);
    const suffix = randomUUID();
    const stateDirectory = await mkdtemp(
      join(tmpdir(), 'vpn-route-delivery-integration-'),
    );
    const [plan, user, node] = await prisma.$transaction([
      prisma.plan.create({
        data: {
          code: `route-delivery-${suffix}`,
          name: 'Route delivery plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 3,
        },
      }),
      prisma.user.create({
        data: {
          telegramUserId: `95${suffix.replaceAll('-', '').slice(0, 20)}`,
        },
      }),
      prisma.node.create({
        data: {
          name: `route-delivery-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      }),
    ]);
    const [device, unrelatedDevice, pendingDevice] = await prisma.$transaction([
      prisma.device.create({
        data: {
          userId: user.id,
          subscriptionTokenHash: `route-delivery-${suffix}`,
        },
      }),
      prisma.device.create({
        data: {
          userId: user.id,
          subscriptionTokenHash: `route-unrelated-${suffix}`,
        },
      }),
      prisma.device.create({
        data: {
          userId: user.id,
          subscriptionTokenHash: `route-pending-${suffix}`,
        },
      }),
    ]);
    await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: 'ACTIVE',
        startsAt: new Date(),
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    await prisma.nodeAccessGrant.create({
      data: {
        nodeId: node.id,
        deviceId: device.id,
        status: 'ACTIVE',
        dataPlaneCredentialHash: `route-baseline-${suffix}`,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    const unrelatedGrant = await orchestration.scheduleNodeAccessGrant({
      nodeId: node.id,
      deviceId: unrelatedDevice.id,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      syncJobIdempotencyKey: `unrelated-grant-sync-${suffix}`,
      outboxEventIdempotencyKey: `unrelated-grant-outbox-${suffix}`,
    });
    const endpoint = await prisma.endpoint.create({
      data: {
        nodeId: node.id,
        host: 'delivered.example.test',
        addressKind: 'HOSTNAME',
        port: 443,
      },
    });
    const profile = await prisma.connectionProfile.create({
      data: {
        nodeId: node.id,
        version: 1,
        status: 'ACTIVE',
        protocolKind: 'VLESS',
        transportKind: 'TCP',
        securityKind: 'TLS',
        clientCompatibility: 'HAPP',
      },
    });
    await prisma.vlessTcpTlsPublicConfig.create({
      data: {
        connectionProfileId: profile.id,
        tlsServerName: 'delivered.example.test',
        displayName: 'Delivered route',
      },
    });
    const publishInput = {
      nodeId: node.id,
      endpointId: endpoint.id,
      connectionProfileId: profile.id,
      syncJobIdempotencyKey: `delivered-route-sync-${suffix}`,
      outboxEventIdempotencyKey: `delivered-route-outbox-${suffix}`,
    };
    const [publication, retriedPublication] = await Promise.all([
      orchestration.publishConnectionRoute(publishInput),
      orchestration.publishConnectionRoute(publishInput),
    ]);
    expect(retriedPublication).toEqual(publication);
    expect(publication.activationVersion).toBe(2);
    const select = () =>
      routes.selectForAuthorizedDevice({
        userId: user.id,
        deviceId: device.id,
      });
    await expect(select()).resolves.toEqual([]);

    await completeInfrastructureNodeSyncJob(
      prisma,
      unrelatedGrant.nodeSyncJobId,
      `unrelated-${suffix}`,
    );
    const nodeCredential = await nodeCredentials.rotate(node.id);
    const undelivered = await request(app.getHttpServer())
      .get('/node-agent/v1/configuration')
      .set('authorization', `Bearer ${nodeCredential.secret}`)
      .expect(200);
    expect(undelivered.body.pendingAcknowledgement).toBeNull();
    expect(undelivered.body.routes[0]).toMatchObject({
      activationVersion: publication.activationVersion,
      endpoint: {
        id: endpoint.id,
        host: 'delivered.example.test',
        addressKind: 'HOSTNAME',
        port: 443,
      },
      profile: {
        id: profile.id,
        version: 1,
        protocolKind: 'VLESS',
        transportKind: 'TCP',
        securityKind: 'TLS',
        clientCompatibility: 'HAPP',
      },
      publicConfig: {
        kind: 'VLESS_TCP_TLS',
        tlsServerName: 'delivered.example.test',
        displayName: 'Delivered route',
      },
    });
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${nodeCredential.secret}`)
      .send({
        nodeSyncJobId: unrelatedGrant.nodeSyncJobId,
        targetVersion: unrelatedGrant.targetVersion,
        snapshotHash: 'a'.repeat(64),
      })
      .expect(409);
    await expect(
      prisma.node.findUniqueOrThrow({
        where: { id: node.id },
        select: { appliedConfigVersion: true },
      }),
    ).resolves.toEqual({ appliedConfigVersion: 0 });
    await expect(select()).resolves.toEqual([]);

    await completeInfrastructureNodeSyncJob(
      prisma,
      publication.nodeSyncJobId,
      `route-${suffix}`,
    );
    const delivered = await request(app.getHttpServer())
      .get('/node-agent/v1/configuration')
      .set('authorization', `Bearer ${nodeCredential.secret}`)
      .expect(200);
    const acknowledgement = delivered.body.pendingAcknowledgement;
    expect(acknowledgement).toMatchObject({
      nodeSyncJobId: publication.nodeSyncJobId,
      targetVersion: publication.activationVersion,
      snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await new StateFileSimulationAdapter(
      join(stateDirectory, 'state.json'),
    ).apply(nodeAgentConfigurationSnapshotSchema.parse(delivered.body));
    await Promise.all([
      request(app.getHttpServer())
        .post('/node-agent/v1/acknowledgements')
        .set('authorization', `Bearer ${nodeCredential.secret}`)
        .send(acknowledgement)
        .expect(204),
      request(app.getHttpServer())
        .post('/node-agent/v1/acknowledgements')
        .set('authorization', `Bearer ${nodeCredential.secret}`)
        .send(acknowledgement)
        .expect(204),
    ]);
    await expect(select()).resolves.toHaveLength(1);
    await expect(
      prisma.nodeConfigAcknowledgement.count({
        where: { nodeSyncJobId: publication.nodeSyncJobId },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.nodeSyncJob.count({
        where: {
          routeEndpointId: endpoint.id,
          routeConnectionProfileId: profile.id,
          targetVersion: publication.activationVersion,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.outboxEvent.count({
        where: { idempotencyKey: publishInput.outboxEventIdempotencyKey },
      }),
    ).resolves.toBe(1);

    await orchestration.scheduleNodeAccessGrant({
      nodeId: node.id,
      deviceId: pendingDevice.id,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      syncJobIdempotencyKey: `pending-grant-sync-${suffix}`,
      outboxEventIdempotencyKey: `pending-grant-outbox-${suffix}`,
    });
    await expect(select()).resolves.toHaveLength(1);
    await prisma.node.update({
      where: { id: node.id },
      data: { status: 'DRAINING' },
    });
    await expect(select()).resolves.toEqual([]);
    const pendingGrantJob = await prisma.nodeSyncJob.findUniqueOrThrow({
      where: { idempotencyKey: `pending-grant-sync-${suffix}` },
    });
    await completeInfrastructureNodeSyncJob(
      prisma,
      pendingGrantJob.id,
      `pending-grant-${suffix}`,
    );
    const pendingGrantSnapshot = await request(app.getHttpServer())
      .get('/node-agent/v1/configuration')
      .set('authorization', `Bearer ${nodeCredential.secret}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${nodeCredential.secret}`)
      .send(pendingGrantSnapshot.body.pendingAcknowledgement)
      .expect(204);
    await prisma.node.update({
      where: { id: node.id },
      data: { status: 'HEALTHY' },
    });
    await expect(select()).resolves.toEqual([]);
    await expect(
      prisma.endpointConnectionProfile.findUniqueOrThrow({
        where: {
          endpointId_connectionProfileId: {
            endpointId: endpoint.id,
            connectionProfileId: profile.id,
          },
        },
        select: { activationVersion: true },
      }),
    ).resolves.toEqual({ activationVersion: null });

    const failedEndpoint = await prisma.endpoint.create({
      data: {
        nodeId: node.id,
        host: 'rollback.example.test',
        addressKind: 'HOSTNAME',
        port: 443,
      },
    });
    const failedProfile = await prisma.connectionProfile.create({
      data: {
        nodeId: node.id,
        version: 1,
        status: 'ACTIVE',
        protocolKind: 'VLESS',
        transportKind: 'TCP',
        securityKind: 'TLS',
        clientCompatibility: 'HAPP',
      },
    });
    await prisma.vlessTcpTlsPublicConfig.create({
      data: {
        connectionProfileId: failedProfile.id,
        tlsServerName: 'rollback.example.test',
        displayName: 'Rollback route',
      },
    });
    const versionBeforeFailure = await prisma.node.findUniqueOrThrow({
      where: { id: node.id },
      select: { desiredConfigVersion: true },
    });
    const failedSyncKey = `failed-route-sync-${suffix}`;
    const failedOutboxKey = `failed-route-outbox-${suffix}`;
    await expect(
      orchestration.publishConnectionRoute({
        nodeId: node.id,
        endpointId: failedEndpoint.id,
        connectionProfileId: failedProfile.id,
        syncJobIdempotencyKey: failedSyncKey,
        outboxEventIdempotencyKey: failedOutboxKey,
        actorUserId: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      prisma.node.findUniqueOrThrow({
        where: { id: node.id },
        select: { desiredConfigVersion: true },
      }),
    ).resolves.toEqual(versionBeforeFailure);
    await expect(
      prisma.endpointConnectionProfile.findUnique({
        where: {
          endpointId_connectionProfileId: {
            endpointId: failedEndpoint.id,
            connectionProfileId: failedProfile.id,
          },
        },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.nodeSyncJob.count({
        where: { idempotencyKey: failedSyncKey },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.outboxEvent.count({
        where: { idempotencyKey: failedOutboxKey },
      }),
    ).resolves.toBe(0);
    await rm(stateDirectory, { recursive: true, force: true });
  });

  it('retries the same route publish after fail-closed and requires a new rollout to reopen', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const nodeCredentials = app.get(NodeAgentCredentialService);
    const routes = app.get(ConnectionRouteSelectionService);
    const suffix = randomUUID();
    const stateDirectory = await mkdtemp(
      join(tmpdir(), 'vpn-route-fail-closed-'),
    );
    const [plan, user, node] = await prisma.$transaction([
      prisma.plan.create({
        data: {
          code: `route-closed-${suffix}`,
          name: 'Route fail-closed plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 1,
        },
      }),
      prisma.user.create({
        data: {
          telegramUserId: `96${suffix.replaceAll('-', '').slice(0, 20)}`,
        },
      }),
      prisma.node.create({
        data: {
          name: `route-closed-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      }),
    ]);
    const device = await prisma.device.create({
      data: {
        userId: user.id,
        subscriptionTokenHash: `route-closed-${suffix}`,
      },
    });
    await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: 'ACTIVE',
        startsAt: new Date(),
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    await prisma.nodeAccessGrant.create({
      data: {
        nodeId: node.id,
        deviceId: device.id,
        status: 'ACTIVE',
        dataPlaneCredentialHash: `route-closed-grant-${suffix}`,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    const endpoint = await prisma.endpoint.create({
      data: {
        nodeId: node.id,
        host: 'fail-closed.example.test',
        addressKind: 'HOSTNAME',
        port: 443,
      },
    });
    const profile = await prisma.connectionProfile.create({
      data: {
        nodeId: node.id,
        version: 1,
        status: 'ACTIVE',
        protocolKind: 'VLESS',
        transportKind: 'TCP',
        securityKind: 'TLS',
        clientCompatibility: 'HAPP',
      },
    });
    await prisma.vlessTcpTlsPublicConfig.create({
      data: {
        connectionProfileId: profile.id,
        tlsServerName: 'fail-closed.example.test',
        displayName: 'Fail-closed route',
      },
    });
    const publishInput = {
      nodeId: node.id,
      endpointId: endpoint.id,
      connectionProfileId: profile.id,
      syncJobIdempotencyKey: `closed-route-sync-${suffix}`,
      outboxEventIdempotencyKey: `closed-route-outbox-${suffix}`,
    };
    const publication =
      await orchestration.publishConnectionRoute(publishInput);
    await prisma.endpoint.update({
      where: { id: endpoint.id },
      data: { status: 'DISABLED' },
    });
    const select = () =>
      routes.selectForAuthorizedDevice({
        userId: user.id,
        deviceId: device.id,
      });
    await expect(select()).resolves.toEqual([]);

    const retriedPublication =
      await orchestration.publishConnectionRoute(publishInput);
    expect(retriedPublication).toEqual(publication);
    await expect(
      prisma.nodeSyncJob.count({
        where: {
          routeEndpointId: endpoint.id,
          routeConnectionProfileId: profile.id,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.outboxEvent.count({
        where: { idempotencyKey: publishInput.outboxEventIdempotencyKey },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.endpointConnectionProfile.findUniqueOrThrow({
        where: {
          endpointId_connectionProfileId: {
            endpointId: endpoint.id,
            connectionProfileId: profile.id,
          },
        },
        select: { activationVersion: true, lastActivationVersion: true },
      }),
    ).resolves.toEqual({
      activationVersion: null,
      lastActivationVersion: publication.activationVersion,
    });

    const replacement = await orchestration.publishConnectionRoute({
      nodeId: node.id,
      endpointId: endpoint.id,
      connectionProfileId: profile.id,
      syncJobIdempotencyKey: `closed-route-resync-${suffix}`,
      outboxEventIdempotencyKey: `closed-route-reoutbox-${suffix}`,
    });
    expect(replacement.activationVersion).toBeGreaterThan(
      publication.activationVersion,
    );
    expect(replacement.nodeSyncJobId).not.toBe(publication.nodeSyncJobId);
    await expect(
      prisma.node.findUniqueOrThrow({
        where: { id: node.id },
        select: { desiredConfigVersion: true, appliedConfigVersion: true },
      }),
    ).resolves.toMatchObject({
      desiredConfigVersion: replacement.activationVersion,
      appliedConfigVersion: 0,
    });
    await expect(select()).resolves.toEqual([]);

    const nodeCredential = await nodeCredentials.rotate(node.id);
    await deliverNodeConfig(
      app,
      nodeCredential.secret,
      replacement.nodeSyncJobId,
      join(stateDirectory, 'state.json'),
    );
    await expect(select()).resolves.toHaveLength(1);
    await rm(stateDirectory, { recursive: true, force: true });
  });

  it('uses the same table-driven public config validation domain in PostgreSQL', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const node = await prisma.node.create({
      data: {
        name: `validation-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
      },
    });

    for (const validationCase of vlessPublicConfigValidationMatrix) {
      const profile = await prisma.connectionProfile.create({
        data: {
          nodeId: node.id,
          version: 1,
          protocolKind: 'VLESS',
          transportKind: 'TCP',
          securityKind: 'TLS',
          clientCompatibility: 'HAPP',
        },
      });
      const operation = prisma.vlessTcpTlsPublicConfig.create({
        data: {
          connectionProfileId: profile.id,
          tlsServerName:
            validationCase.field === 'tlsServerName'
              ? validationCase.value
              : 'matrix.example.test',
          displayName:
            validationCase.field === 'displayName'
              ? validationCase.value
              : 'Matrix route',
        },
      });
      if (validationCase.accepted) {
        await expect(operation, validationCase.name).resolves.toMatchObject({
          connectionProfileId: profile.id,
        });
      } else {
        await expect(operation, validationCase.name).rejects.toThrow();
      }
    }
  });

  it('selects only eligible connection routes without changing the subscription token', async () => {
    const prisma = app.get(PrismaService);
    const routes = app.get(ConnectionRouteSelectionService);
    const orchestration = app.get(OrchestrationService);
    const nodeCredentials = app.get(NodeAgentCredentialService);
    const suffix = randomUUID();
    const stateDirectory = await mkdtemp(
      join(tmpdir(), 'vpn-route-selection-integration-'),
    );
    const farFuture = new Date('2099-01-01T00:00:00.000Z');
    const [plan, owner, other] = await prisma.$transaction([
      prisma.plan.create({
        data: {
          code: `routes-${suffix}`,
          name: 'Connection routes integration plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 3,
        },
      }),
      prisma.user.create({
        data: {
          telegramUserId: `71${suffix.replaceAll('-', '').slice(0, 20)}`,
        },
      }),
      prisma.user.create({
        data: {
          telegramUserId: `72${suffix.replaceAll('-', '').slice(0, 20)}`,
        },
      }),
    ]);
    const [device, otherDevice] = await prisma.$transaction([
      prisma.device.create({
        data: {
          userId: owner.id,
          subscriptionTokenHash: `route-token-${suffix}`,
        },
      }),
      prisma.device.create({
        data: {
          userId: other.id,
          subscriptionTokenHash: `other-route-token-${suffix}`,
        },
      }),
    ]);
    await prisma.subscription.create({
      data: {
        userId: owner.id,
        planId: plan.id,
        status: 'ACTIVE',
        startsAt: new Date('2026-08-01T00:00:00.000Z'),
        expiresAt: farFuture,
      },
    });
    const [firstNode, secondNode, drainingNode, legacyOnlyNode] =
      await prisma.$transaction([
        prisma.node.create({
          data: {
            name: `routes-first-${suffix}`,
            provider: 'integration-test',
            locationLabel: 'integration-test',
            endpoint: 'legacy-first.example.test',
            status: 'HEALTHY',
          },
        }),
        prisma.node.create({
          data: {
            name: `routes-second-${suffix}`,
            provider: 'integration-test',
            locationLabel: 'integration-test',
            status: 'HEALTHY',
          },
        }),
        prisma.node.create({
          data: {
            name: `routes-draining-${suffix}`,
            provider: 'integration-test',
            locationLabel: 'integration-test',
            status: 'DRAINING',
          },
        }),
        prisma.node.create({
          data: {
            name: `routes-legacy-only-${suffix}`,
            provider: 'integration-test',
            locationLabel: 'integration-test',
            endpoint: 'legacy-only.example.test',
            status: 'HEALTHY',
          },
        }),
      ]);
    const [firstGrant, secondGrant, drainingGrant, legacyOnlyGrant] =
      await prisma.$transaction([
        prisma.nodeAccessGrant.create({
          data: {
            nodeId: firstNode.id,
            deviceId: device.id,
            status: 'ACTIVE',
            dataPlaneCredentialHash: `route-grant-first-${suffix}`,
            expiresAt: farFuture,
          },
        }),
        prisma.nodeAccessGrant.create({
          data: {
            nodeId: secondNode.id,
            deviceId: device.id,
            status: 'ACTIVE',
            dataPlaneCredentialHash: `route-grant-second-${suffix}`,
            expiresAt: farFuture,
          },
        }),
        prisma.nodeAccessGrant.create({
          data: {
            nodeId: drainingNode.id,
            deviceId: device.id,
            status: 'ACTIVE',
            dataPlaneCredentialHash: `route-grant-draining-${suffix}`,
            expiresAt: farFuture,
          },
        }),
        prisma.nodeAccessGrant.create({
          data: {
            nodeId: legacyOnlyNode.id,
            deviceId: device.id,
            status: 'ACTIVE',
            dataPlaneCredentialHash: `route-grant-legacy-${suffix}`,
            expiresAt: farFuture,
          },
        }),
      ]);
    const [firstEndpoint, disabledEndpoint, secondEndpoint, drainingEndpoint] =
      await prisma.$transaction([
        prisma.endpoint.create({
          data: {
            nodeId: firstNode.id,
            host: 'first.example.test',
            addressKind: 'HOSTNAME',
            port: 443,
            priority: 20,
          },
        }),
        prisma.endpoint.create({
          data: {
            nodeId: firstNode.id,
            host: 'disabled.example.test',
            addressKind: 'HOSTNAME',
            port: 443,
            priority: 0,
            status: 'DISABLED',
          },
        }),
        prisma.endpoint.create({
          data: {
            nodeId: secondNode.id,
            host: '2001:db8::10',
            addressKind: 'IPV6',
            port: 443,
            priority: 5,
          },
        }),
        prisma.endpoint.create({
          data: {
            nodeId: drainingNode.id,
            host: '198.51.100.10',
            addressKind: 'IPV4',
            port: 443,
          },
        }),
      ]);
    const profileKey = randomUUID();
    const [
      firstProfile,
      firstProfileSecondVersion,
      secondProfile,
      drainingProfile,
    ] = await prisma.$transaction([
      prisma.connectionProfile.create({
        data: {
          nodeId: firstNode.id,
          profileKey,
          version: 1,
          status: 'ACTIVE',
          protocolKind: 'VLESS',
          transportKind: 'TCP',
          securityKind: 'TLS',
          clientCompatibility: 'HAPP',
          priority: 20,
        },
      }),
      prisma.connectionProfile.create({
        data: {
          nodeId: firstNode.id,
          profileKey,
          version: 2,
          status: 'DRAFT',
          protocolKind: 'VLESS',
          transportKind: 'WEBSOCKET',
          securityKind: 'TLS',
          clientCompatibility: 'HAPP',
          priority: 0,
        },
      }),
      prisma.connectionProfile.create({
        data: {
          nodeId: secondNode.id,
          version: 1,
          status: 'ACTIVE',
          protocolKind: 'VLESS',
          transportKind: 'TCP',
          securityKind: 'TLS',
          clientCompatibility: 'HAPP',
          priority: 10,
        },
      }),
      prisma.connectionProfile.create({
        data: {
          nodeId: drainingNode.id,
          version: 1,
          status: 'ACTIVE',
          protocolKind: 'VLESS',
          transportKind: 'TCP',
          securityKind: 'TLS',
          clientCompatibility: 'HAPP',
        },
      }),
    ]);
    await prisma.vlessTcpTlsPublicConfig.createMany({
      data: [
        {
          connectionProfileId: firstProfile.id,
          tlsServerName: 'first.example.test',
          displayName: 'First route',
        },
        {
          connectionProfileId: secondProfile.id,
          tlsServerName: 'second.example.test',
          displayName: 'Second route',
        },
      ],
    });
    await prisma.endpointConnectionProfile.createMany({
      data: [
        {
          endpointId: firstEndpoint.id,
          connectionProfileId: firstProfile.id,
          nodeId: firstNode.id,
        },
        {
          endpointId: disabledEndpoint.id,
          connectionProfileId: firstProfile.id,
          nodeId: firstNode.id,
        },
        {
          endpointId: secondEndpoint.id,
          connectionProfileId: secondProfile.id,
          nodeId: secondNode.id,
        },
        {
          endpointId: drainingEndpoint.id,
          connectionProfileId: drainingProfile.id,
          nodeId: drainingNode.id,
        },
      ],
    });
    const firstPublication = await orchestration.publishConnectionRoute({
      nodeId: firstNode.id,
      endpointId: firstEndpoint.id,
      connectionProfileId: firstProfile.id,
      syncJobIdempotencyKey: `first-route-sync-${suffix}`,
      outboxEventIdempotencyKey: `first-route-outbox-${suffix}`,
    });
    const secondPublication = await orchestration.publishConnectionRoute({
      nodeId: secondNode.id,
      endpointId: secondEndpoint.id,
      connectionProfileId: secondProfile.id,
      syncJobIdempotencyKey: `second-route-sync-${suffix}`,
      outboxEventIdempotencyKey: `second-route-outbox-${suffix}`,
    });
    const legacyEndpoint = await prisma.endpoint.create({
      data: {
        nodeId: legacyOnlyNode.id,
        host: 'legacy-mapping.example.test',
        addressKind: 'HOSTNAME',
        port: 443,
      },
    });
    const legacyProfile = await prisma.connectionProfile.create({
      data: {
        nodeId: legacyOnlyNode.id,
        version: 1,
        status: 'ACTIVE',
        protocolKind: 'VLESS',
        transportKind: 'TCP',
        securityKind: 'TLS',
        clientCompatibility: 'HAPP',
      },
    });
    await prisma.endpointConnectionProfile.create({
      data: {
        endpointId: legacyEndpoint.id,
        connectionProfileId: legacyProfile.id,
        nodeId: legacyOnlyNode.id,
      },
    });
    await expect(
      prisma.endpointConnectionProfile.findUniqueOrThrow({
        where: {
          endpointId_connectionProfileId: {
            endpointId: legacyEndpoint.id,
            connectionProfileId: legacyProfile.id,
          },
        },
        select: { activationVersion: true },
      }),
    ).resolves.toEqual({ activationVersion: null });
    const firstNodeCredential = await nodeCredentials.rotate(firstNode.id);
    const secondNodeCredential = await nodeCredentials.rotate(secondNode.id);
    await deliverNodeConfig(
      app,
      firstNodeCredential.secret,
      firstPublication.nodeSyncJobId,
      join(stateDirectory, 'first-node.json'),
    );
    await deliverNodeConfig(
      app,
      secondNodeCredential.secret,
      secondPublication.nodeSyncJobId,
      join(stateDirectory, 'second-node.json'),
    );

    const select = () =>
      routes.selectForAuthorizedDevice({
        userId: owner.id,
        deviceId: device.id,
      });
    const initial = await select();
    expect(initial.map((route) => route.nodeId)).toEqual([
      secondNode.id,
      firstNode.id,
    ]);
    expect(await select()).toEqual(initial);
    await expect(
      routes.selectForAuthorizedDevice({
        userId: owner.id,
        deviceId: device.id,
        limit: 1,
      }),
    ).resolves.toEqual(initial.slice(0, 2));
    expect(initial.map((route) => route.nodeId)).not.toContain(drainingNode.id);
    expect(initial.map((route) => route.nodeId)).not.toContain(
      legacyOnlyNode.id,
    );
    expect(
      await prisma.endpoint.count({ where: { nodeId: firstNode.id } }),
    ).toBe(2);
    expect(
      await prisma.connectionProfile.count({
        where: { nodeId: firstNode.id, profileKey },
      }),
    ).toBe(2);
    expect(firstProfileSecondVersion.status).toBe('DRAFT');
    expect(JSON.stringify(initial)).not.toMatch(
      /credential|subscriptionUrl|route-token/i,
    );

    const replacementEndpoint = await prisma.endpoint.create({
      data: {
        nodeId: firstNode.id,
        host: 'replacement.example.test',
        addressKind: 'HOSTNAME',
        port: 443,
        priority: 1,
      },
    });
    const replacementPublication = await orchestration.publishConnectionRoute({
      nodeId: firstNode.id,
      endpointId: replacementEndpoint.id,
      connectionProfileId: firstProfile.id,
      syncJobIdempotencyKey: `replacement-route-sync-${suffix}`,
      outboxEventIdempotencyKey: `replacement-route-outbox-${suffix}`,
    });
    const pendingRollout = await prisma.node.findUniqueOrThrow({
      where: { id: firstNode.id },
      select: { desiredConfigVersion: true, appliedConfigVersion: true },
    });
    expect(pendingRollout.desiredConfigVersion).toBeGreaterThan(
      pendingRollout.appliedConfigVersion,
    );
    const whilePending = await select();
    expect(whilePending.map((route) => route.endpointId)).toContain(
      firstEndpoint.id,
    );
    expect(whilePending.map((route) => route.endpointId)).not.toContain(
      replacementEndpoint.id,
    );
    await deliverNodeConfig(
      app,
      firstNodeCredential.secret,
      replacementPublication.nodeSyncJobId,
      join(stateDirectory, 'first-node.json'),
    );
    const tokenBeforeReplacement = await prisma.device.findUniqueOrThrow({
      where: { id: device.id },
      select: { subscriptionTokenHash: true },
    });
    expect((await select()).map((route) => route.endpointId)).toContain(
      replacementEndpoint.id,
    );
    await prisma.endpoint.update({
      where: { id: firstEndpoint.id },
      data: { status: 'DISABLED' },
    });
    expect((await select()).map((route) => route.endpointId)).not.toContain(
      firstEndpoint.id,
    );
    await prisma.endpoint.update({
      where: { id: firstEndpoint.id },
      data: { status: 'ACTIVE' },
    });
    const alreadyAppliedRouteJob = await prisma.nodeSyncJob.create({
      data: {
        nodeId: firstNode.id,
        routeEndpointId: firstEndpoint.id,
        routeConnectionProfileId: firstProfile.id,
        targetVersion: replacementPublication.activationVersion,
        idempotencyKey: `already-applied-route-sync-${suffix}`,
      },
    });
    await prisma.outboxEvent.create({
      data: {
        topic: 'node-sync.requested',
        aggregateType: 'ConnectionRoute',
        aggregateId: firstEndpoint.id,
        payload: {
          routeEndpointId: firstEndpoint.id,
          routeConnectionProfileId: firstProfile.id,
          nodeSyncJobId: alreadyAppliedRouteJob.id,
          targetVersion: replacementPublication.activationVersion,
        },
        idempotencyKey: `already-applied-route-outbox-${suffix}`,
      },
    });
    await expect(
      prisma.endpointConnectionProfile.update({
        where: {
          endpointId_connectionProfileId: {
            endpointId: firstEndpoint.id,
            connectionProfileId: firstProfile.id,
          },
        },
        data: {
          activationVersion: replacementPublication.activationVersion,
        },
      }),
    ).rejects.toThrow('must be newer than the applied node configuration');
    await prisma.endpoint.update({
      where: { id: firstEndpoint.id },
      data: { status: 'DISABLED' },
    });
    await expect(
      prisma.device.findUniqueOrThrow({
        where: { id: device.id },
        select: { subscriptionTokenHash: true },
      }),
    ).resolves.toEqual(tokenBeforeReplacement);
    await expect(
      prisma.$executeRaw`
        UPDATE "Endpoint"
        SET "host" = 'mutated.example.test'
        WHERE "id" = ${replacementEndpoint.id}::uuid
      `,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`
        UPDATE "ConnectionProfile"
        SET "version" = "version" + 1
        WHERE "id" = ${firstProfile.id}::uuid
      `,
    ).rejects.toThrow();

    await prisma.endpoint.update({
      where: { id: replacementEndpoint.id },
      data: { status: 'DISABLED' },
    });
    const beforeRepublish = await prisma.node.findUniqueOrThrow({
      where: { id: firstNode.id },
      select: { desiredConfigVersion: true },
    });
    await prisma.endpoint.update({
      where: { id: replacementEndpoint.id },
      data: { status: 'ACTIVE' },
    });
    expect((await select()).map((route) => route.endpointId)).not.toContain(
      replacementEndpoint.id,
    );
    await expect(
      prisma.endpointConnectionProfile.update({
        where: {
          endpointId_connectionProfileId: {
            endpointId: replacementEndpoint.id,
            connectionProfileId: firstProfile.id,
          },
        },
        data: {
          activationVersion: replacementPublication.activationVersion,
        },
      }),
    ).rejects.toThrow('must increase beyond every prior activation');
    const republishInput = {
      nodeId: firstNode.id,
      endpointId: replacementEndpoint.id,
      connectionProfileId: firstProfile.id,
      syncJobIdempotencyKey: `republish-route-sync-${suffix}`,
      outboxEventIdempotencyKey: `republish-route-outbox-${suffix}`,
    };
    const [republished, retriedRepublish] = await Promise.all([
      orchestration.publishConnectionRoute(republishInput),
      orchestration.publishConnectionRoute(republishInput),
    ]);
    expect(retriedRepublish).toEqual(republished);
    expect(republished.activationVersion).toBe(
      beforeRepublish.desiredConfigVersion + 1,
    );
    expect((await select()).map((route) => route.endpointId)).not.toContain(
      replacementEndpoint.id,
    );
    await deliverNodeConfig(
      app,
      firstNodeCredential.secret,
      republished.nodeSyncJobId,
      join(stateDirectory, 'first-node.json'),
    );
    expect((await select()).map((route) => route.endpointId)).toContain(
      replacementEndpoint.id,
    );

    await prisma.connectionProfile.update({
      where: { id: firstProfile.id },
      data: { status: 'DISABLED' },
    });
    expect((await select()).map((route) => route.nodeId)).toEqual([
      secondNode.id,
    ]);
    await prisma.connectionProfile.update({
      where: { id: firstProfile.id },
      data: { status: 'ACTIVE' },
    });
    expect((await select()).map((route) => route.nodeId)).toEqual([
      secondNode.id,
    ]);
    const profileReactivation = await orchestration.publishConnectionRoute({
      nodeId: firstNode.id,
      endpointId: replacementEndpoint.id,
      connectionProfileId: firstProfile.id,
      syncJobIdempotencyKey: `profile-reactivation-sync-${suffix}`,
      outboxEventIdempotencyKey: `profile-reactivation-outbox-${suffix}`,
    });
    expect((await select()).map((route) => route.nodeId)).toEqual([
      secondNode.id,
    ]);
    await deliverNodeConfig(
      app,
      firstNodeCredential.secret,
      profileReactivation.nodeSyncJobId,
      join(stateDirectory, 'first-node.json'),
    );

    await prisma.nodeAccessGrant.update({
      where: { id: secondGrant.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    expect((await select()).map((route) => route.nodeId)).toEqual([
      firstNode.id,
    ]);
    await prisma.nodeAccessGrant.update({
      where: { id: secondGrant.id },
      data: { status: 'ACTIVE', revokedAt: null },
    });

    await prisma.subscription.updateMany({
      where: { userId: owner.id },
      data: {
        startsAt: new Date('1999-01-01T00:00:00.000Z'),
        expiresAt: new Date('2000-01-01T00:00:00.000Z'),
      },
    });
    await expect(select()).resolves.toEqual([]);
    await prisma.subscription.updateMany({
      where: { userId: owner.id },
      data: {
        startsAt: new Date('2026-08-01T00:00:00.000Z'),
        expiresAt: farFuture,
      },
    });

    await prisma.device.update({
      where: { id: device.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    await expect(select()).resolves.toEqual([]);
    await prisma.device.update({
      where: { id: device.id },
      data: { status: 'ACTIVE', revokedAt: null },
    });
    await expect(
      routes.selectForAuthorizedDevice({
        userId: other.id,
        deviceId: device.id,
      }),
    ).resolves.toEqual([]);
    await expect(
      routes.selectForAuthorizedDevice({
        userId: owner.id,
        deviceId: otherDevice.id,
      }),
    ).resolves.toEqual([]);

    await expect(
      prisma.endpoint.create({
        data: {
          nodeId: firstNode.id,
          host: 'invalid-port.example.test',
          addressKind: 'HOSTNAME',
          port: 0,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.connectionProfile.create({
        data: {
          nodeId: firstNode.id,
          version: 0,
          protocolKind: 'VLESS',
          transportKind: 'TCP',
          securityKind: 'TLS',
          clientCompatibility: 'HAPP',
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "EndpointConnectionProfile" ("endpointId", "connectionProfileId", "nodeId")
        VALUES (${replacementEndpoint.id}::uuid, ${secondProfile.id}::uuid, ${firstNode.id}::uuid)
      `,
    ).rejects.toThrow();
    await expect(
      prisma.endpointConnectionProfile.create({
        data: {
          endpointId: firstEndpoint.id,
          connectionProfileId: firstProfileSecondVersion.id,
          nodeId: firstNode.id,
          activationVersion: 1,
        },
      }),
    ).rejects.toThrow();

    expect(firstGrant.status).toBe('ACTIVE');
    expect(drainingGrant.status).toBe('ACTIVE');
    expect(legacyOnlyGrant.status).toBe('ACTIVE');
    await rm(stateDirectory, { recursive: true, force: true });
  });
});
