import {
  ServiceUnavailableException,
  type INestApplication,
} from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  cabinetOverviewSchema,
  issuedCabinetDeviceSchema,
  nodeAgentConfigurationSnapshotSchema,
  readinessResponseSchema,
  subscriptionFeedSchema,
} from '@vpn-platform/contracts';
import {
  HttpNodeAgentControlPlane,
  NodeAgentRunner,
  StateFileSimulationAdapter,
} from '@vpn-platform/node-agent';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Redis from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import {
  API_ENVIRONMENT,
  parseApiEnvironment,
} from '../src/config/environment';
import { PrismaService } from '../src/database/prisma.service';
import { NodeAgentCredentialService } from '../src/orchestration/node-agent-credential.service';
import { OrchestrationService } from '../src/orchestration/orchestration.service';
import { DataPlaneCredentialService } from '../src/orchestration/data-plane-credential.service';
import { RedisService } from '../src/redis/redis.service';
import { TrustedPrelaunchService } from '../src/auth/trusted-prelaunch.service';
import { ConnectionRouteSelectionService } from '../src/subscription-access/connection-route-selection.service';
import { vlessPublicConfigValidationMatrix } from '../src/subscription-access/vless-public-config.validation-matrix';

const telegramBotToken = '123456:integration-test-telegram-token';

async function deliverNodeConfig(
  app: INestApplication,
  orchestration: OrchestrationService,
  credential: string,
  nodeSyncJobId: string,
  statePath: string,
): Promise<void> {
  const leaseOwner = `integration-delivery-${randomUUID()}`;
  const leaseToken = await orchestration.claimNodeSyncJob(
    nodeSyncJobId,
    leaseOwner,
  );
  if (!leaseToken) throw new Error('Integration sync job was not claimed');
  await expect(
    orchestration.completeNodeSyncJob(nodeSyncJobId, leaseOwner, leaseToken),
  ).resolves.toBe(true);
  const server = app.getHttpServer() as { listening?: boolean };
  if (!server.listening) await app.listen(0, '127.0.0.1');
  await expect(
    new NodeAgentRunner(
      new HttpNodeAgentControlPlane(await app.getUrl(), credential, 5_000),
      new StateFileSimulationAdapter(statePath),
    ).runCycle(),
  ).resolves.toBe('acknowledged');
}

function signedTelegramInitData(
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
    .update(telegramBotToken ?? '')
    .digest();
  parameters.set(
    'hash',
    createHmac('sha256', secretKey).update(dataCheckString).digest('hex'),
  );
  return parameters.toString();
}

function authenticatedNodeId(
  credentials: NodeAgentCredentialService,
  secret: string,
): Promise<string | null> {
  return credentials.withAuthenticatedNodeTransaction(secret, (nodeId) =>
    Promise.resolve(nodeId),
  );
}

describe('infrastructure readiness', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const testingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(API_ENVIRONMENT)
      .useValue(
        parseApiEnvironment({
          ...process.env,
          TELEGRAM_WEB_APP_BOT_TOKEN: telegramBotToken,
          AUTH_PRELAUNCH_RATE_LIMIT_MAX: '3',
          AUTH_CHALLENGE_CLEANUP_BATCH_SIZE: '2',
        }),
      )
      .compile();

    app = testingModule.createNestApplication(
      new FastifyAdapter({ trustProxy: () => true }),
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('executes PostgreSQL SELECT 1 and Redis PING through readiness', async () => {
    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);

    expect(readinessResponseSchema.parse(response.body)).toEqual({
      status: 'ready',
      dependencies: { postgres: 'up', redis: 'up' },
    });
  });

  it('binds Telegram replay retries to one challenge cookie and revokes logout sessions', async () => {
    const prisma = app.get(PrismaService);
    const telegramUserId = `8${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const prelaunch = app.get(TrustedPrelaunchService);
    const context = await prelaunch.issue(`test-${randomUUID()}`);
    const initData = signedTelegramInitData(telegramUserId, context.launchId);
    let userId: string | undefined;

    try {
      const challengeCookie = `vpn_platform_prelaunch=${context.secret}`;

      const first = await request(app.getHttpServer())
        .post('/auth/telegram')
        .set('cookie', challengeCookie)
        .send({ initData })
        .expect(200);
      const sessionCookie = first.headers['set-cookie']?.[0];
      expect(sessionCookie).toContain('vpn_platform_session=');
      if (!sessionCookie) throw new Error('Session cookie is missing');
      userId = first.body.user.id;

      const retry = await request(app.getHttpServer())
        .post('/auth/telegram')
        .set('cookie', challengeCookie)
        .send({ initData })
        .expect(200);
      expect(retry.headers['set-cookie']?.[0]).toBe(sessionCookie);

      const attacker = await request(app.getHttpServer())
        .post('/auth/telegram')
        .set('cookie', `vpn_platform_prelaunch=${'b'.repeat(43)}`)
        .send({ initData })
        .expect(401);
      expect(attacker.headers['set-cookie']).toBeUndefined();

      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('cookie', sessionCookie)
        .expect('cache-control', 'no-store')
        .expect('set-cookie', /Max-Age=0/)
        .expect(204);
      const retryAfterLogout = await request(app.getHttpServer())
        .post('/auth/telegram')
        .set('cookie', challengeCookie)
        .send({ initData })
        .expect(401);
      expect(retryAfterLogout.headers['set-cookie']).toBeUndefined();
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('cookie', sessionCookie)
        .expect(401);
      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('cookie', sessionCookie)
        .expect(204);
    } finally {
      if (userId) {
        await prisma.authChallenge.deleteMany({ where: { userId } });
        await prisma.userSession.deleteMany({ where: { userId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    }
  });

  it('allows no second session for concurrent trusted contexts of one Telegram proof', async () => {
    const prisma = app.get(PrismaService);
    const prelaunch = app.get(TrustedPrelaunchService);
    const telegramUserId = `9${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const queryId = randomUUID();
    const [first, second] = await Promise.all([
      prelaunch.issue(`same-proof-first-${randomUUID()}`),
      prelaunch.issue(`same-proof-second-${randomUUID()}`),
    ]);
    try {
      const responses = await Promise.all([
        request(app.getHttpServer())
          .post('/auth/telegram')
          .set('cookie', `vpn_platform_prelaunch=${first.secret}`)
          .send({
            initData: signedTelegramInitData(
              telegramUserId,
              first.launchId,
              queryId,
            ),
          }),
        request(app.getHttpServer())
          .post('/auth/telegram')
          .set('cookie', `vpn_platform_prelaunch=${second.secret}`)
          .send({
            initData: signedTelegramInitData(
              telegramUserId,
              second.launchId,
              queryId,
            ),
          }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 401,
      ]);
      const user = await prisma.user.findUniqueOrThrow({
        where: { telegramUserId },
      });
      await expect(
        prisma.userSession.count({ where: { userId: user.id } }),
      ).resolves.toBe(1);
      await prisma.authChallenge.deleteMany({ where: { userId: user.id } });
      await prisma.userSession.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    } finally {
      await prisma.authChallenge.deleteMany({
        where: { launchId: { in: [first.launchId, second.launchId] } },
      });
    }
  });

  it('returns one generic HTTP error for invalid Telegram proof and context variants', async () => {
    const prisma = app.get(PrismaService);
    const prelaunch = app.get(TrustedPrelaunchService);
    const context = await prelaunch.issue(`generic-auth-error-${randomUUID()}`);
    const telegramUserId = `4${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const valid = signedTelegramInitData(telegramUserId, context.launchId);
    const forgedParameters = new URLSearchParams(valid);
    forgedParameters.set('hash', '0'.repeat(64));
    const cases = [
      {
        name: 'forged proof',
        cookie: context.secret,
        initData: forgedParameters.toString(),
      },
      {
        name: 'expired proof',
        cookie: context.secret,
        initData: signedTelegramInitData(
          telegramUserId,
          context.launchId,
          randomUUID(),
          Math.floor(Date.now() / 1_000) - 3_601,
        ),
      },
      {
        name: 'wrong pre-launch secret',
        cookie: 'c'.repeat(43),
        initData: valid,
      },
      {
        name: 'wrong signed start_param',
        cookie: context.secret,
        initData: signedTelegramInitData(telegramUserId, 'd'.repeat(43)),
      },
    ];

    try {
      const responses = await Promise.all(
        cases.map(({ cookie, initData }) =>
          request(app.getHttpServer())
            .post('/auth/telegram')
            .set('cookie', `vpn_platform_prelaunch=${cookie}`)
            .send({ initData }),
        ),
      );
      for (const [index, response] of responses.entries()) {
        expect(response.status, cases[index]?.name).toBe(401);
        expect(response.body, cases[index]?.name).toEqual({
          message: 'Telegram login is invalid',
          error: 'Unauthorized',
          statusCode: 401,
        });
        expect(
          response.headers['set-cookie'],
          cases[index]?.name,
        ).toBeUndefined();
      }
    } finally {
      await prisma.authChallenge.deleteMany({
        where: { launchId: context.launchId },
      });
    }
  });

  it('enforces the trusted pre-launch Redis limit atomically with a TTL', async () => {
    const prisma = app.get(PrismaService);
    const prelaunch = app.get(TrustedPrelaunchService);
    const redisService = app.get(RedisService);
    const environment = app.get(API_ENVIRONMENT);
    const identity = `integration-limit-${randomUUID()}`;
    const key = `auth-prelaunch:rate-limit:${identity}`;
    const redis = new Redis(environment.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    const launchIds: string[] = [];
    const challengeCountBefore = await prisma.authChallenge.count();

    try {
      await redis.connect();
      await redisService.delete(key);
      const results = await Promise.allSettled(
        Array.from(
          { length: environment.AUTH_PRELAUNCH_RATE_LIMIT_MAX + 3 },
          () => prelaunch.issue(identity),
        ),
      );
      const successes = results.filter(
        (
          result,
        ): result is PromiseFulfilledResult<{
          launchId: string;
          secret: string;
        }> => result.status === 'fulfilled',
      );
      const failures = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      launchIds.push(...successes.map((result) => result.value.launchId));

      expect(successes).toHaveLength(environment.AUTH_PRELAUNCH_RATE_LIMIT_MAX);
      expect(failures).toHaveLength(3);
      for (const failure of failures) {
        expect(failure.reason.getStatus()).toBe(429);
      }
      expect(
        await prisma.authChallenge.count({
          where: { launchId: { in: launchIds } },
        }),
      ).toBe(environment.AUTH_PRELAUNCH_RATE_LIMIT_MAX);
      expect(await prisma.authChallenge.count()).toBe(
        challengeCountBefore + environment.AUTH_PRELAUNCH_RATE_LIMIT_MAX,
      );
      expect(await redis.pttl(redisService.keyFor(key))).toBeGreaterThan(0);
    } finally {
      await prisma.authChallenge.deleteMany({
        where: { launchId: { in: launchIds } },
      });
      await redisService.delete(key);
      redis.disconnect();
    }
  });

  it('fails trusted pre-launch issuance closed when Redis is unavailable', async () => {
    const prisma = app.get(PrismaService);
    const environment = app.get(API_ENVIRONMENT);
    const before = await prisma.authChallenge.count();
    const failingRedis = {
      incrementWithExpiry: () =>
        Promise.reject(
          new Error('redis://credential-that-must-not-escape@example.test'),
        ),
    } as unknown as RedisService;
    const prelaunch = new TrustedPrelaunchService(
      prisma,
      failingRedis,
      environment,
    );

    const failure = await prelaunch
      .issue(`redis-failure-${randomUUID()}`)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect((failure as ServiceUnavailableException).getStatus()).toBe(503);
    expect((failure as Error).message).toBe('Login preparation is unavailable');
    expect((failure as Error).message).not.toContain('credential-that');
    await expect(prisma.authChallenge.count()).resolves.toBe(before);
  });

  it('bounds challenge cleanup and treats maintenance failure as non-fatal', async () => {
    const prisma = app.get(PrismaService);
    const environment = app.get(API_ENVIRONMENT);
    const redis = {
      incrementWithExpiry: () => Promise.resolve(1),
    } as unknown as RedisService;
    const prelaunch = new TrustedPrelaunchService(prisma, redis, environment);
    const suffix = randomUUID().replaceAll('-', '');
    const expiredLaunchIds = Array.from(
      { length: environment.AUTH_CHALLENGE_CLEANUP_BATCH_SIZE + 1 },
      (_, index) => `cleanup-${index}-${suffix}`,
    );
    let activeLaunchId: string | undefined;
    let failureLaunchId: string | undefined;

    try {
      await prisma.authChallenge.createMany({
        data: expiredLaunchIds.map((launchId, index) => ({
          launchId,
          tokenHash: createHmac('sha256', 'cleanup-integration')
            .update(launchId)
            .digest('hex'),
          createdAt: new Date(`2000-01-0${index + 1}T00:00:00.000Z`),
          expiresAt: new Date(`2000-01-0${index + 2}T00:00:00.000Z`),
        })),
      });

      const active = await prelaunch.issue(`cleanup-success-${suffix}`);
      activeLaunchId = active.launchId;
      expect(
        await prisma.authChallenge.count({
          where: { launchId: { in: expiredLaunchIds } },
        }),
      ).toBe(1);
      await expect(
        prisma.authChallenge.findUnique({
          where: { launchId: active.launchId },
        }),
      ).resolves.not.toBeNull();

      let transactionCall = 0;
      const failingPrisma = {
        $transaction: (
          callback: Parameters<PrismaService['$transaction']>[0],
        ) => {
          transactionCall += 1;
          if (transactionCall === 1) {
            return prisma.$transaction(callback as never);
          }
          return Promise.reject(new Error('cleanup failed'));
        },
      } as unknown as PrismaService;
      const failureTolerant = new TrustedPrelaunchService(
        failingPrisma,
        redis,
        environment,
      );
      const issued = await failureTolerant.issue(`cleanup-failure-${suffix}`);
      failureLaunchId = issued.launchId;
      await expect(
        prisma.authChallenge.findUnique({
          where: { launchId: issued.launchId },
        }),
      ).resolves.not.toBeNull();
    } finally {
      await prisma.authChallenge.deleteMany({
        where: {
          launchId: {
            in: [
              ...expiredLaunchIds,
              ...(activeLaunchId ? [activeLaunchId] : []),
              ...(failureLaunchId ? [failureLaunchId] : []),
            ],
          },
        },
      });
    }
  });

  it('rejects a challenge that expires while login waits for its row lock', async () => {
    const prisma = app.get(PrismaService);
    const prelaunch = app.get(TrustedPrelaunchService);
    const telegramUserId = `6${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const context = await prelaunch.issue(`expiry-lock-${randomUUID()}`);
    const expiresAt = new Date(Date.now() + 1_500);
    let releaseLock: (() => void) | undefined;
    let heldLock: Promise<void> | undefined;

    try {
      await prisma.authChallenge.update({
        where: { launchId: context.launchId },
        data: { expiresAt },
      });
      let signalLockAcquired: (() => void) | undefined;
      const lockAcquired = new Promise<void>((resolve) => {
        signalLockAcquired = resolve;
      });
      heldLock = prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT "id" FROM "AuthChallenge"
          WHERE "launchId" = ${context.launchId}
          FOR UPDATE
        `;
        signalLockAcquired?.();
        await new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
      });
      await lockAcquired;
      expect(Date.now()).toBeLessThan(expiresAt.getTime());

      const login = request(app.getHttpServer())
        .post('/auth/telegram')
        .set('cookie', `vpn_platform_prelaunch=${context.secret}`)
        .send({
          initData: signedTelegramInitData(telegramUserId, context.launchId),
        })
        .then((response) => response);

      let waitingForLock = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const [waiting] = await prisma.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND query LIKE '%AuthChallenge%FOR UPDATE%'
          ) AS waiting
        `;
        if (waiting?.waiting) {
          waitingForLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waitingForLock).toBe(true);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 50)),
      );
      releaseLock?.();
      const response = await login;
      await heldLock;

      expect(response.status).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
      await expect(
        prisma.userSession.count({
          where: { user: { telegramUserId } },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.authChallenge.findUniqueOrThrow({
          where: { launchId: context.launchId },
          select: { consumedAt: true, sessionId: true },
        }),
      ).resolves.toEqual({ consumedAt: null, sessionId: null });
    } finally {
      releaseLock?.();
      await heldLock?.catch(() => undefined);
      await prisma.authChallenge.deleteMany({
        where: { launchId: context.launchId },
      });
      await prisma.userSession.deleteMany({
        where: { user: { telegramUserId } },
      });
      await prisma.user.deleteMany({ where: { telegramUserId } });
    }
  });

  it('rejects retries whose bound session no longer matches the proof or secret', async () => {
    const prisma = app.get(PrismaService);
    const prelaunch = app.get(TrustedPrelaunchService);
    const telegramUserId = `5${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const context = await prelaunch.issue(`retry-binding-${randomUUID()}`);
    const initData = signedTelegramInitData(telegramUserId, context.launchId);
    let userId: string | undefined;

    try {
      const first = await request(app.getHttpServer())
        .post('/auth/telegram')
        .set('cookie', `vpn_platform_prelaunch=${context.secret}`)
        .send({ initData })
        .expect(200);
      userId = first.body.user.id;
      const challenge = await prisma.authChallenge.findUniqueOrThrow({
        where: { launchId: context.launchId },
      });
      if (!challenge.sessionId || !challenge.userId) {
        throw new Error('Consumed challenge binding is missing');
      }
      const original = await prisma.userSession.findUniqueOrThrow({
        where: { id: challenge.sessionId },
      });
      const retry = () =>
        request(app.getHttpServer())
          .post('/auth/telegram')
          .set('cookie', `vpn_platform_prelaunch=${context.secret}`)
          .send({ initData });
      const expectGenericRejection = (
        response: Awaited<ReturnType<typeof retry>>,
      ) => {
        expect(response.status).toBe(401);
        expect(response.body).toEqual({
          message: 'Telegram login is invalid',
          error: 'Unauthorized',
          statusCode: 401,
        });
        expect(response.headers['set-cookie']).toBeUndefined();
      };

      await prisma.userSession.update({
        where: { id: original.id },
        data: { telegramReplayHash: '1'.repeat(64) },
      });
      let rejected = await retry();
      expectGenericRejection(rejected);
      await prisma.userSession.update({
        where: { id: original.id },
        data: { telegramReplayHash: original.telegramReplayHash },
      });

      await prisma.userSession.update({
        where: { id: original.id },
        data: { tokenHash: '2'.repeat(64) },
      });
      rejected = await retry();
      expectGenericRejection(rejected);
      await prisma.userSession.update({
        where: { id: original.id },
        data: { tokenHash: original.tokenHash },
      });

      const otherUser = await prisma.user.create({
        data: {
          telegramUserId: `6${Date.now()}${Math.floor(Math.random() * 1_000_000)}`,
        },
      });
      try {
        await prisma.userSession.update({
          where: { id: original.id },
          data: { userId: otherUser.id },
        });
        const cascadedChallenge = await prisma.authChallenge.findUniqueOrThrow({
          where: { launchId: context.launchId },
        });
        expect(cascadedChallenge.userId).toBe(otherUser.id);

        rejected = await retry();
        expectGenericRejection(rejected);
      } finally {
        await prisma.userSession.update({
          where: { id: original.id },
          data: { userId: original.userId },
        });
        await prisma.user.delete({ where: { id: otherUser.id } });
      }

      await prisma.userSession.update({
        where: { id: original.id },
        data: { revokedAt: new Date() },
      });
      rejected = await retry();
      expectGenericRejection(rejected);
      await prisma.userSession.update({
        where: { id: original.id },
        data: { revokedAt: null },
      });

      await prisma.userSession.update({
        where: { id: original.id },
        data: { expiresAt: new Date('2001-01-01T00:00:00.000Z') },
      });
      rejected = await retry();
      expectGenericRejection(rejected);
    } finally {
      if (userId) {
        await prisma.authChallenge.deleteMany({ where: { userId } });
        await prisma.userSession.deleteMany({ where: { userId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      } else {
        await prisma.authChallenge.deleteMany({
          where: { launchId: context.launchId },
        });
      }
    }
  });

  it('enforces AuthChallenge state and composite ownership in PostgreSQL', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID().replaceAll('-', '');
    const launchIds: string[] = [];
    let firstUserId: string | undefined;
    let secondUserId: string | undefined;
    let firstSessionId: string | undefined;
    let secondSessionId: string | undefined;
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const expiresAt = new Date('2026-01-02T00:00:00.000Z');
    const consumedAt = new Date('2026-01-01T00:01:00.000Z');
    const newIdentity = (label: string) => {
      const launchId = `${label}-${suffix}`;
      launchIds.push(launchId);
      return {
        launchId,
        tokenHash: createHmac('sha256', 'constraint-integration')
          .update(launchId)
          .digest('hex'),
      };
    };

    try {
      const [firstUser, secondUser] = await prisma.$transaction([
        prisma.user.create({
          data: { telegramUserId: `31${suffix.slice(0, 20)}` },
        }),
        prisma.user.create({
          data: { telegramUserId: `32${suffix.slice(0, 20)}` },
        }),
      ]);
      firstUserId = firstUser.id;
      secondUserId = secondUser.id;
      const [firstSession, secondSession] = await prisma.$transaction([
        prisma.userSession.create({
          data: {
            userId: firstUser.id,
            tokenHash: createHmac('sha256', 'constraint-session')
              .update(`first-${suffix}`)
              .digest('hex'),
            telegramReplayHash: createHmac('sha256', 'constraint-replay')
              .update(`first-${suffix}`)
              .digest('hex'),
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          },
        }),
        prisma.userSession.create({
          data: {
            userId: secondUser.id,
            tokenHash: createHmac('sha256', 'constraint-session')
              .update(`second-${suffix}`)
              .digest('hex'),
            telegramReplayHash: createHmac('sha256', 'constraint-replay')
              .update(`second-${suffix}`)
              .digest('hex'),
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          },
        }),
      ]);
      firstSessionId = firstSession.id;
      secondSessionId = secondSession.id;

      const invalidWrites = [
        prisma.authChallenge.create({
          data: {
            ...newIdentity('consumed-only'),
            createdAt,
            expiresAt,
            consumedAt,
          },
        }),
        prisma.authChallenge.create({
          data: {
            ...newIdentity('replay-only'),
            createdAt,
            expiresAt,
            telegramReplayHash: '3'.repeat(64),
          },
        }),
        prisma.authChallenge.create({
          data: {
            ...newIdentity('binding-without-consumed'),
            createdAt,
            expiresAt,
            telegramReplayHash: '4'.repeat(64),
            sessionId: firstSession.id,
            userId: firstUser.id,
          },
        }),
        prisma.authChallenge.create({
          data: {
            ...newIdentity('partial-consumed'),
            createdAt,
            expiresAt,
            consumedAt,
            telegramReplayHash: '5'.repeat(64),
            userId: firstUser.id,
          },
        }),
        prisma.authChallenge.create({
          data: {
            ...newIdentity('invalid-expiry'),
            createdAt,
            expiresAt: createdAt,
          },
        }),
        prisma.authChallenge.create({
          data: {
            ...newIdentity('consumed-before-created'),
            createdAt,
            expiresAt,
            consumedAt: new Date('2025-12-31T23:59:59.000Z'),
            telegramReplayHash: '6'.repeat(64),
            sessionId: firstSession.id,
            userId: firstUser.id,
          },
        }),
        prisma.authChallenge.create({
          data: {
            ...newIdentity('cross-user-session'),
            createdAt,
            expiresAt,
            consumedAt,
            telegramReplayHash: '7'.repeat(64),
            sessionId: firstSession.id,
            userId: secondUser.id,
          },
        }),
      ];
      for (const write of invalidWrites) {
        await expect(write).rejects.toBeDefined();
      }
      await expect(
        prisma.authChallenge.count({
          where: { launchId: { in: launchIds } },
        }),
      ).resolves.toBe(0);

      const validIdentity = newIdentity('restrict-session-delete');
      await prisma.authChallenge.create({
        data: {
          ...validIdentity,
          createdAt,
          expiresAt,
          consumedAt,
          telegramReplayHash: firstSession.telegramReplayHash,
          sessionId: firstSession.id,
          userId: firstUser.id,
        },
      });
      await expect(
        prisma.userSession.delete({ where: { id: firstSession.id } }),
      ).rejects.toBeDefined();
      await expect(
        prisma.authChallenge.findUnique({
          where: { launchId: validIdentity.launchId },
        }),
      ).resolves.not.toBeNull();
    } finally {
      await prisma.authChallenge.deleteMany({
        where: { launchId: { in: launchIds } },
      });
      if (firstSessionId || secondSessionId) {
        await prisma.userSession.deleteMany({
          where: {
            id: {
              in: [firstSessionId, secondSessionId].filter(
                (id): id is string => id !== undefined,
              ),
            },
          },
        });
      }
      if (firstUserId || secondUserId) {
        await prisma.user.deleteMany({
          where: {
            id: {
              in: [firstUserId, secondUserId].filter(
                (id): id is string => id !== undefined,
              ),
            },
          },
        });
      }
    }
  });

  it('serializes concurrent idempotent desired-state scheduling', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const suffix = randomUUID();
    const telegramUserId = suffix.replaceAll('-', '');
    const syncJobIdempotencyKey = `concurrent-sync-${suffix}`;
    const outboxEventIdempotencyKey = `concurrent-outbox-${suffix}`;
    let userId: string | undefined;
    let planId: string | undefined;
    let deviceId: string | undefined;
    let nodeId: string | undefined;

    try {
      const plan = await prisma.plan.create({
        data: {
          code: `concurrent-${suffix}`,
          name: 'Concurrent integration plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 1,
        },
      });
      planId = plan.id;
      const user = await prisma.user.create({ data: { telegramUserId } });
      userId = user.id;
      await prisma.subscription.create({
        data: {
          userId: user.id,
          planId: plan.id,
          status: 'ACTIVE',
          startsAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const device = await prisma.device.create({
        data: {
          userId: user.id,
          displayName: 'Concurrent integration device',
          subscriptionTokenHash: `concurrent-feed-hash-${suffix}`,
        },
      });
      deviceId = device.id;
      const node = await prisma.node.create({
        data: {
          name: `concurrent-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      });
      nodeId = node.id;
      const input = {
        nodeId: node.id,
        deviceId: device.id,
        expiresAt: new Date(Date.now() + 60_000),
        syncJobIdempotencyKey,
        outboxEventIdempotencyKey,
      };

      const [first, second] = await Promise.all([
        orchestration.scheduleNodeAccessGrant(input),
        orchestration.scheduleNodeAccessGrant(input),
      ]);

      expect(second).toEqual(first);
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
      ).resolves.toMatchObject({ desiredConfigVersion: 1 });
      await expect(
        prisma.nodeAccessGrant.count({ where: { deviceId: device.id } }),
      ).resolves.toBe(1);
      await expect(
        prisma.nodeSyncJob.count({
          where: { idempotencyKey: syncJobIdempotencyKey },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.outboxEvent.count({
          where: { idempotencyKey: outboxEventIdempotencyKey },
        }),
      ).resolves.toBe(1);
    } finally {
      await prisma.nodeSyncJob.deleteMany({
        where: { idempotencyKey: syncJobIdempotencyKey },
      });
      await prisma.outboxEvent.deleteMany({
        where: { idempotencyKey: outboxEventIdempotencyKey },
      });
      if (deviceId) {
        await prisma.nodeAccessGrant.deleteMany({ where: { deviceId } });
      }
      if (userId) {
        await prisma.subscription.deleteMany({ where: { userId } });
        await prisma.device.deleteMany({ where: { userId } });
      }
      if (nodeId) {
        await prisma.node.delete({ where: { id: nodeId } });
      }
      if (userId) {
        await prisma.user.delete({ where: { id: userId } });
      }
      if (planId) {
        await prisma.plan.delete({ where: { id: planId } });
      }
    }
  });

  it('orders concurrent desired-state scheduling for different devices', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const suffix = randomUUID();
    const telegramUserId = suffix.replaceAll('-', '');
    let userId: string | undefined;
    let nodeId: string | undefined;
    let outboxEventIds: string[] = [];

    try {
      const user = await prisma.user.create({ data: { telegramUserId } });
      userId = user.id;
      const [firstDevice, secondDevice] = await prisma.$transaction([
        prisma.device.create({
          data: {
            userId: user.id,
            displayName: 'First concurrent integration device',
            subscriptionTokenHash: `first-concurrent-feed-hash-${suffix}`,
          },
        }),
        prisma.device.create({
          data: {
            userId: user.id,
            displayName: 'Second concurrent integration device',
            subscriptionTokenHash: `second-concurrent-feed-hash-${suffix}`,
          },
        }),
      ]);
      const node = await prisma.node.create({
        data: {
          name: `different-concurrent-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      });
      nodeId = node.id;
      const expiresAt = new Date(Date.now() + 60_000);

      const [first, second] = await Promise.all([
        orchestration.scheduleNodeAccessGrant({
          nodeId: node.id,
          deviceId: firstDevice.id,
          expiresAt,
          syncJobIdempotencyKey: `first-concurrent-sync-${suffix}`,
          outboxEventIdempotencyKey: `first-concurrent-outbox-${suffix}`,
        }),
        orchestration.scheduleNodeAccessGrant({
          nodeId: node.id,
          deviceId: secondDevice.id,
          expiresAt,
          syncJobIdempotencyKey: `second-concurrent-sync-${suffix}`,
          outboxEventIdempotencyKey: `second-concurrent-outbox-${suffix}`,
        }),
      ]);
      outboxEventIds = [first.outboxEventId, second.outboxEventId];

      expect([first.targetVersion, second.targetVersion].sort()).toEqual([
        1, 2,
      ]);
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
      ).resolves.toMatchObject({ desiredConfigVersion: 2 });
      await expect(
        prisma.nodeAccessGrant.count({ where: { nodeId: node.id } }),
      ).resolves.toBe(2);
      await expect(
        prisma.nodeSyncJob.count({ where: { nodeId: node.id } }),
      ).resolves.toBe(2);
      await expect(
        prisma.outboxEvent.count({ where: { id: { in: outboxEventIds } } }),
      ).resolves.toBe(2);
    } finally {
      if (nodeId) {
        await prisma.nodeSyncJob.deleteMany({ where: { nodeId } });
      }
      if (outboxEventIds.length > 0) {
        await prisma.outboxEvent.deleteMany({
          where: { id: { in: outboxEventIds } },
        });
      }
      if (nodeId) {
        await prisma.nodeAccessGrant.deleteMany({ where: { nodeId } });
      }
      if (userId) {
        await prisma.device.deleteMany({ where: { userId } });
      }
      if (nodeId) {
        await prisma.node.delete({ where: { id: nodeId } });
      }
      if (userId) {
        await prisma.user.delete({ where: { id: userId } });
      }
    }
  });

  it('fences stale workers after a lease is reclaimed', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const suffix = randomUUID();
    const telegramUserId = suffix.replaceAll('-', '');
    let userId: string | undefined;
    let deviceId: string | undefined;
    let nodeId: string | undefined;
    let grantId: string | undefined;
    let nodeSyncJobId: string | undefined;
    let outboxEventId: string | undefined;

    try {
      const user = await prisma.user.create({ data: { telegramUserId } });
      const device = await prisma.device.create({
        data: {
          userId: user.id,
          displayName: 'Lease fencing integration device',
          subscriptionTokenHash: `lease-fencing-feed-hash-${suffix}`,
        },
      });
      const node = await prisma.node.create({
        data: {
          name: `lease-fencing-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      });
      const grant = await prisma.nodeAccessGrant.create({
        data: {
          nodeId: node.id,
          deviceId: device.id,
          dataPlaneCredentialHash: `lease-fencing-credential-hash-${suffix}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      grantId = grant.id;
      const syncJob = await prisma.nodeSyncJob.create({
        data: {
          nodeId: node.id,
          nodeAccessGrantId: grant.id,
          targetVersion: 0,
          idempotencyKey: `lease-fencing-sync-${suffix}`,
        },
      });
      nodeSyncJobId = syncJob.id;
      const outboxEvent = await prisma.outboxEvent.create({
        data: {
          topic: 'node-sync.requested',
          aggregateType: 'NodeAccessGrant',
          aggregateId: grant.id,
          payload: { nodeAccessGrantId: grant.id },
          idempotencyKey: `lease-fencing-outbox-${suffix}`,
        },
      });
      outboxEventId = outboxEvent.id;
      const claimedAt = new Date('2026-08-11T08:00:00.000Z');
      const expiredAt = new Date('2026-08-11T08:00:30.000Z');

      const staleNodeSyncToken = await orchestration.claimNodeSyncJob(
        syncJob.id,
        'worker-a',
        claimedAt,
      );
      const staleOutboxToken = await orchestration.claimOutboxEvent(
        outboxEvent.id,
        'worker-a',
        claimedAt,
      );
      expect(staleNodeSyncToken).toEqual(expect.any(String));
      expect(staleOutboxToken).toEqual(expect.any(String));
      await expect(
        orchestration.completeNodeSyncJob(
          syncJob.id,
          'worker-b',
          staleNodeSyncToken as string,
          claimedAt,
        ),
      ).resolves.toBe(false);
      await expect(
        orchestration.publishOutboxEvent(
          outboxEvent.id,
          'worker-b',
          staleOutboxToken as string,
          claimedAt,
        ),
      ).resolves.toBe(false);
      await expect(
        orchestration.reclaimExpiredLeases(expiredAt),
      ).resolves.toEqual({ nodeSyncJobs: 1, outboxEvents: 1 });

      const currentNodeSyncToken = await orchestration.claimNodeSyncJob(
        syncJob.id,
        'worker-b',
        expiredAt,
      );
      const currentOutboxToken = await orchestration.claimOutboxEvent(
        outboxEvent.id,
        'worker-b',
        expiredAt,
      );
      expect(currentNodeSyncToken).toEqual(expect.any(String));
      expect(currentOutboxToken).toEqual(expect.any(String));
      expect(currentNodeSyncToken).not.toBe(staleNodeSyncToken);
      expect(currentOutboxToken).not.toBe(staleOutboxToken);
      await expect(
        orchestration.completeNodeSyncJob(
          syncJob.id,
          'worker-a',
          staleNodeSyncToken as string,
          expiredAt,
        ),
      ).resolves.toBe(false);
      await expect(
        orchestration.publishOutboxEvent(
          outboxEvent.id,
          'worker-a',
          staleOutboxToken as string,
          expiredAt,
        ),
      ).resolves.toBe(false);
      await expect(
        orchestration.completeNodeSyncJob(
          syncJob.id,
          'worker-b',
          currentNodeSyncToken as string,
          expiredAt,
        ),
      ).resolves.toBe(true);
      await expect(
        orchestration.publishOutboxEvent(
          outboxEvent.id,
          'worker-b',
          currentOutboxToken as string,
          expiredAt,
        ),
      ).resolves.toBe(true);
      await expect(
        prisma.nodeSyncJob.findUniqueOrThrow({ where: { id: syncJob.id } }),
      ).resolves.toMatchObject({ status: 'SUCCEEDED', completedAt: expiredAt });
      await expect(
        prisma.outboxEvent.findUniqueOrThrow({ where: { id: outboxEvent.id } }),
      ).resolves.toMatchObject({ status: 'PUBLISHED', publishedAt: expiredAt });
      await expect(
        prisma.nodeSyncJob.update({
          where: { id: syncJob.id },
          data: { lastErrorCode: 'LATE_MUTATION' },
        }),
      ).rejects.toThrow('NodeSyncJob terminal state is immutable');
      await expect(
        prisma.outboxEvent.update({
          where: { id: outboxEvent.id },
          data: { lastErrorCode: 'LATE_MUTATION' },
        }),
      ).rejects.toThrow('OutboxEvent terminal state is immutable');
    } finally {
      if (nodeSyncJobId) {
        await prisma.nodeSyncJob.delete({ where: { id: nodeSyncJobId } });
      }
      if (outboxEventId) {
        await prisma.outboxEvent.delete({ where: { id: outboxEventId } });
      }
      if (grantId) {
        await prisma.nodeAccessGrant.delete({ where: { id: grantId } });
      }
      if (deviceId) {
        await prisma.device.delete({ where: { id: deviceId } });
      }
      if (nodeId) {
        await prisma.node.delete({ where: { id: nodeId } });
      }
      if (userId) {
        await prisma.user.delete({ where: { id: userId } });
      }
    }
  });

  it('stops retrying terminal work after the configured attempt limit', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const suffix = randomUUID();
    const telegramUserId = suffix.replaceAll('-', '');
    let userId: string | undefined;
    let deviceId: string | undefined;
    let nodeId: string | undefined;
    let nodeAccessGrantId: string | undefined;
    let nodeSyncJobId: string | undefined;
    let outboxEventId: string | undefined;

    try {
      const user = await prisma.user.create({ data: { telegramUserId } });
      userId = user.id;
      const device = await prisma.device.create({
        data: {
          userId: user.id,
          displayName: 'Retry limit integration device',
          subscriptionTokenHash: `retry-limit-feed-hash-${suffix}`,
        },
      });
      deviceId = device.id;
      const node = await prisma.node.create({
        data: {
          name: `retry-limit-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      });
      nodeId = node.id;
      const scheduled = await orchestration.scheduleNodeAccessGrant({
        nodeId: node.id,
        deviceId: device.id,
        expiresAt: new Date(Date.now() + 60_000),
        syncJobIdempotencyKey: `retry-limit-sync-${suffix}`,
        outboxEventIdempotencyKey: `retry-limit-outbox-${suffix}`,
      });
      nodeAccessGrantId = scheduled.nodeAccessGrantId;
      nodeSyncJobId = scheduled.nodeSyncJobId;
      outboxEventId = scheduled.outboxEventId;

      let nodeSyncNow = new Date('2026-08-11T09:00:00.000Z');
      for (let attempt = 1; attempt < 5; attempt += 1) {
        const token = await orchestration.claimNodeSyncJob(
          scheduled.nodeSyncJobId,
          'worker-a',
          nodeSyncNow,
        );
        expect(token).toEqual(expect.any(String));
        const nextAttemptAt = new Date(nodeSyncNow.getTime() + 1_000);
        await expect(
          orchestration.retryNodeSyncJob(
            scheduled.nodeSyncJobId,
            'worker-a',
            token as string,
            nextAttemptAt,
            'NETWORK_ERROR',
            nodeSyncNow,
          ),
        ).resolves.toBe(true);
        nodeSyncNow = nextAttemptAt;
      }
      const finalNodeSyncToken = await orchestration.claimNodeSyncJob(
        scheduled.nodeSyncJobId,
        'worker-a',
        nodeSyncNow,
      );
      expect(finalNodeSyncToken).toEqual(expect.any(String));
      await expect(
        orchestration.retryNodeSyncJob(
          scheduled.nodeSyncJobId,
          'worker-a',
          finalNodeSyncToken as string,
          new Date(nodeSyncNow.getTime() + 1_000),
          'NETWORK_ERROR',
          nodeSyncNow,
        ),
      ).resolves.toBe(true);
      await expect(
        prisma.nodeSyncJob.findUniqueOrThrow({
          where: { id: scheduled.nodeSyncJobId },
        }),
      ).resolves.toMatchObject({
        status: 'FAILED',
        attempts: 5,
        lastErrorCode: 'NETWORK_ERROR',
        completedAt: nodeSyncNow,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      });
      await expect(
        orchestration.claimNodeSyncJob(
          scheduled.nodeSyncJobId,
          'worker-a',
          nodeSyncNow,
        ),
      ).resolves.toBeNull();

      let outboxNow = new Date('2026-08-11T10:00:00.000Z');
      for (let attempt = 1; attempt < 5; attempt += 1) {
        const token = await orchestration.claimOutboxEvent(
          scheduled.outboxEventId,
          'worker-a',
          outboxNow,
        );
        expect(token).toEqual(expect.any(String));
        const nextAttemptAt = new Date(outboxNow.getTime() + 1_000);
        await expect(
          orchestration.retryOutboxEvent(
            scheduled.outboxEventId,
            'worker-a',
            token as string,
            nextAttemptAt,
            'NETWORK_ERROR',
            outboxNow,
          ),
        ).resolves.toBe(true);
        outboxNow = nextAttemptAt;
      }
      const finalOutboxToken = await orchestration.claimOutboxEvent(
        scheduled.outboxEventId,
        'worker-a',
        outboxNow,
      );
      expect(finalOutboxToken).toEqual(expect.any(String));
      await expect(
        orchestration.retryOutboxEvent(
          scheduled.outboxEventId,
          'worker-a',
          finalOutboxToken as string,
          new Date(outboxNow.getTime() + 1_000),
          'NETWORK_ERROR',
          outboxNow,
        ),
      ).resolves.toBe(true);
      await expect(
        prisma.outboxEvent.findUniqueOrThrow({
          where: { id: scheduled.outboxEventId },
        }),
      ).resolves.toMatchObject({
        status: 'FAILED',
        attempts: 5,
        lastErrorCode: 'NETWORK_ERROR',
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      });
      await expect(
        orchestration.claimOutboxEvent(
          scheduled.outboxEventId,
          'worker-a',
          outboxNow,
        ),
      ).resolves.toBeNull();
      await expect(
        prisma.nodeSyncJob.update({
          where: { id: scheduled.nodeSyncJobId },
          data: { lastErrorCode: 'LATE_MUTATION' },
        }),
      ).rejects.toThrow('NodeSyncJob terminal state is immutable');
      await expect(
        prisma.outboxEvent.update({
          where: { id: scheduled.outboxEventId },
          data: { lastErrorCode: 'LATE_MUTATION' },
        }),
      ).rejects.toThrow('OutboxEvent terminal state is immutable');
    } finally {
      if (nodeSyncJobId) {
        await prisma.nodeSyncJob.delete({ where: { id: nodeSyncJobId } });
      }
      if (outboxEventId) {
        await prisma.outboxEvent.delete({ where: { id: outboxEventId } });
      }
      if (nodeAccessGrantId) {
        await prisma.nodeAccessGrant.delete({
          where: { id: nodeAccessGrantId },
        });
      }
      if (deviceId) {
        await prisma.device.delete({ where: { id: deviceId } });
      }
      if (nodeId) {
        await prisma.node.delete({ where: { id: nodeId } });
      }
      if (userId) {
        await prisma.user.delete({ where: { id: userId } });
      }
    }
  });

  it('records only succeeded node configuration acknowledgements', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const credentials = app.get(NodeAgentCredentialService);
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { telegramUserId: suffix.replaceAll('-', '') },
    });
    const device = await prisma.device.create({
      data: {
        userId: user.id,
        subscriptionTokenHash: `config-acknowledgement-feed-${suffix}`,
      },
    });
    const node = await prisma.node.create({
      data: {
        name: `config-acknowledgement-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'HEALTHY',
        desiredConfigVersion: 1,
      },
    });
    const grant = await prisma.nodeAccessGrant.create({
      data: {
        nodeId: node.id,
        deviceId: device.id,
        dataPlaneCredentialHash: `config-acknowledgement-credential-${suffix}`,
        expiresAt: new Date('2026-09-01T00:00:00.000Z'),
        desiredVersion: 1,
      },
    });
    const otherNode = await prisma.node.create({
      data: {
        name: `config-acknowledgement-other-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'HEALTHY',
        desiredConfigVersion: 1,
      },
    });
    const otherGrant = await prisma.nodeAccessGrant.create({
      data: {
        nodeId: otherNode.id,
        deviceId: device.id,
        dataPlaneCredentialHash: `config-acknowledgement-other-credential-${suffix}`,
        expiresAt: new Date('2026-09-01T00:00:00.000Z'),
        desiredVersion: 1,
      },
    });
    const syncJob = await prisma.nodeSyncJob.create({
      data: {
        nodeId: node.id,
        nodeAccessGrantId: grant.id,
        targetVersion: 1,
        idempotencyKey: `config-acknowledgement-sync-${suffix}`,
      },
    });
    const now = new Date('2026-08-11T11:00:00.000Z');
    const credential = await credentials.rotate(node.id, now);

    await expect(
      orchestration.acknowledgeNodeConfig(
        {
          nodeId: node.id,
          nodeSyncJobId: syncJob.id,
          targetVersion: 1,
          snapshotHash: 'a'.repeat(64),
        },
        now,
      ),
    ).rejects.toThrow('Node sync job is not eligible for acknowledgement');
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .send({
        nodeSyncJobId: syncJob.id,
        targetVersion: 1,
        snapshotHash: 'a'.repeat(64),
      })
      .expect(401);
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${credential.secret}`)
      .send({ nodeSyncJobId: 'not-a-uuid', targetVersion: -1 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${credential.secret}`)
      .send({
        nodeSyncJobId: syncJob.id,
        targetVersion: 1,
        snapshotHash: 'a'.repeat(64),
      })
      .expect(409);
    await expect(
      prisma.node.update({
        where: { id: node.id },
        data: { appliedConfigVersion: 1 },
      }),
    ).rejects.toThrow('Node appliedConfigVersion requires an acknowledgement');

    const leaseToken = await orchestration.claimNodeSyncJob(
      syncJob.id,
      'worker-a',
      now,
    );
    expect(leaseToken).toEqual(expect.any(String));
    await expect(
      orchestration.completeNodeSyncJob(
        syncJob.id,
        'worker-a',
        leaseToken as string,
        now,
      ),
    ).resolves.toBe(true);

    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${credential.secret}`)
      .send({
        nodeSyncJobId: syncJob.id,
        targetVersion: 1,
        snapshotHash: 'a'.repeat(64),
      })
      .expect(409);
    const deliveredSnapshot = await request(app.getHttpServer())
      .get('/node-agent/v1/configuration')
      .set('authorization', `Bearer ${credential.secret}`)
      .expect(200);
    const acknowledgement = deliveredSnapshot.body.pendingAcknowledgement;
    expect(acknowledgement).toMatchObject({
      nodeSyncJobId: syncJob.id,
      targetVersion: 1,
      snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${credential.secret}`)
      .send(acknowledgement)
      .expect(204);
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${credential.secret}`)
      .send(acknowledgement)
      .expect(204);
    await expect(
      prisma.nodeConfigAcknowledgement.findUniqueOrThrow({
        where: { nodeSyncJobId: syncJob.id },
      }),
    ).resolves.toMatchObject({
      nodeId: node.id,
      targetVersion: 1,
      snapshotHash: acknowledgement.snapshotHash,
      acknowledgedAt: expect.any(Date),
    });
    await expect(
      prisma.nodeAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
    ).resolves.toMatchObject({ desiredVersion: 1, appliedVersion: 1 });
    await expect(
      prisma.nodeAccessGrant.findUniqueOrThrow({
        where: { id: otherGrant.id },
      }),
    ).resolves.toMatchObject({ desiredVersion: 1, appliedVersion: 0 });
    await expect(
      prisma.node.update({
        where: { id: node.id },
        data: { appliedConfigVersion: 0 },
      }),
    ).rejects.toThrow('Node appliedConfigVersion cannot decrease');
    await expect(
      prisma.nodeConfigAcknowledgement.update({
        where: { nodeSyncJobId: syncJob.id },
        data: { acknowledgedAt: new Date(now.getTime() + 1_000) },
      }),
    ).rejects.toThrow('NodeConfigAcknowledgement is append-only');
    await expect(credentials.revoke(node.id, now)).resolves.toBe(true);
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${credential.secret}`)
      .send(acknowledgement)
      .expect(401);
    const disabledNodeCredential = await credentials.rotate(node.id, now);
    await prisma.node.update({
      where: { id: node.id },
      data: { status: 'DISABLED' },
    });
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${disabledNodeCredential.secret}`)
      .send(acknowledgement)
      .expect(401);
  });

  it('rotates and revokes hashed node-agent credentials', async () => {
    const prisma = app.get(PrismaService);
    const credentials = app.get(NodeAgentCredentialService);
    const suffix = randomUUID();
    const node = await prisma.node.create({
      data: {
        name: `agent-credential-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'HEALTHY',
      },
    });
    const firstRotationAt = new Date('2026-08-11T12:00:00.000Z');
    const secondRotationAt = new Date('2026-08-11T12:01:00.000Z');

    try {
      const first = await credentials.rotate(node.id, firstRotationAt);
      expect(first.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await expect(
        authenticatedNodeId(credentials, first.secret),
      ).resolves.toBe(node.id);
      await expect(
        authenticatedNodeId(credentials, 'not-a-credential'),
      ).resolves.toBeNull();
      await expect(
        prisma.nodeAgentCredential.findUniqueOrThrow({
          where: { id: first.credentialId },
        }),
      ).resolves.toMatchObject({
        nodeId: node.id,
        secretHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        revokedAt: null,
      });
      await expect(
        prisma.nodeAgentCredential.create({
          data: {
            nodeId: node.id,
            secretHash: 'a'.repeat(64),
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      const second = await credentials.rotate(node.id, secondRotationAt);
      expect(second.secret).not.toBe(first.secret);
      await expect(
        authenticatedNodeId(credentials, first.secret),
      ).resolves.toBeNull();
      await expect(
        authenticatedNodeId(credentials, second.secret),
      ).resolves.toBe(node.id);
      await expect(
        prisma.nodeAgentCredential.findUniqueOrThrow({
          where: { id: first.credentialId },
        }),
      ).resolves.toMatchObject({ revokedAt: secondRotationAt });
      await expect(
        prisma.nodeAgentCredential.count({
          where: { nodeId: node.id, revokedAt: null },
        }),
      ).resolves.toBe(1);

      let releaseOperation: (() => void) | undefined;
      let signalOperationStarted: (() => void) | undefined;
      const operationStarted = new Promise<void>((resolve) => {
        signalOperationStarted = resolve;
      });
      const protectedOperation = credentials.withAuthenticatedNodeTransaction(
        second.secret,
        async () => {
          signalOperationStarted?.();
          await new Promise<void>((resolve) => {
            releaseOperation = resolve;
          });
          return true;
        },
      );
      await operationStarted;
      let revocationCompleted = false;
      const pendingRevocation = credentials
        .revoke(node.id, secondRotationAt)
        .then((result) => {
          revocationCompleted = true;
          return result;
        });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(revocationCompleted).toBe(false);
      releaseOperation?.();
      await expect(protectedOperation).resolves.toBe(true);
      await expect(pendingRevocation).resolves.toBe(true);
      await expect(
        authenticatedNodeId(credentials, second.secret),
      ).resolves.toBeNull();

      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'DISABLED' },
      });
      await expect(
        authenticatedNodeId(credentials, second.secret),
      ).resolves.toBeNull();
      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'HEALTHY' },
      });
      await expect(credentials.revoke(node.id, secondRotationAt)).resolves.toBe(
        false,
      );
    } finally {
      await prisma.nodeAgentCredential.deleteMany({
        where: { nodeId: node.id },
      });
      await prisma.node.delete({ where: { id: node.id } });
    }
  });

  it('derives one stable credential per grant and scopes it to its node', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const credentials = app.get(NodeAgentCredentialService);
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { telegramUserId: suffix.replaceAll('-', '') },
    });
    const device = await prisma.device.create({
      data: {
        userId: user.id,
        subscriptionTokenHash: `credential-feed-${suffix}`,
      },
    });
    const [firstNode, secondNode] = await prisma.$transaction([
      prisma.node.create({
        data: {
          name: `credential-first-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      }),
      prisma.node.create({
        data: {
          name: `credential-second-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      }),
    ]);
    const expiresAt = new Date('2099-01-01T00:00:00.000Z');
    const first = await orchestration.scheduleNodeAccessGrant({
      nodeId: firstNode.id,
      deviceId: device.id,
      expiresAt,
      syncJobIdempotencyKey: `credential-sync-${suffix}`,
      outboxEventIdempotencyKey: `credential-outbox-${suffix}`,
    });
    const repeated = await orchestration.scheduleNodeAccessGrant({
      nodeId: firstNode.id,
      deviceId: device.id,
      expiresAt,
      syncJobIdempotencyKey: `credential-sync-${suffix}`,
      outboxEventIdempotencyKey: `credential-outbox-${suffix}`,
    });
    const second = await orchestration.scheduleNodeAccessGrant({
      nodeId: secondNode.id,
      deviceId: device.id,
      expiresAt,
      syncJobIdempotencyKey: `credential-second-sync-${suffix}`,
      outboxEventIdempotencyKey: `credential-second-outbox-${suffix}`,
    });
    expect(repeated.nodeAccessGrantId).toBe(first.nodeAccessGrantId);
    const [firstGrant] = await prisma.$transaction([
      prisma.nodeAccessGrant.findUniqueOrThrow({
        where: { id: first.nodeAccessGrantId },
      }),
      prisma.nodeAccessGrant.findUniqueOrThrow({
        where: { id: second.nodeAccessGrantId },
      }),
    ]);
    expect(firstGrant.dataPlaneCredentialDerivationVersion).toBe(1);
    const firstNodeCredential = await credentials.rotate(firstNode.id);
    const secondNodeCredential = await credentials.rotate(secondNode.id);
    const [firstSnapshot, secondSnapshot] = await Promise.all([
      request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${firstNodeCredential.secret}`)
        .expect(200),
      request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${secondNodeCredential.secret}`)
        .expect(200),
    ]);
    const firstCredential = firstSnapshot.body.grants[0].dataPlaneCredential;
    const secondCredential = secondSnapshot.body.grants[0].dataPlaneCredential;
    expect(firstCredential).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondCredential).toMatch(/^[0-9a-f-]{36}$/);
    expect(firstCredential).not.toBe(secondCredential);
    expect(firstGrant.dataPlaneCredentialHash).not.toBe(firstCredential);
    expect(
      JSON.stringify(
        await prisma.outboxEvent.findUniqueOrThrow({
          where: { id: first.outboxEventId },
        }),
      ),
    ).not.toContain(firstCredential);
    expect(
      JSON.stringify(
        await prisma.auditEvent.findMany({
          where: { entityId: first.nodeAccessGrantId },
        }),
      ),
    ).not.toContain(firstCredential);
    await prisma.nodeAccessGrant.update({
      where: { id: first.nodeAccessGrantId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    const revoked = await request(app.getHttpServer())
      .get('/node-agent/v1/configuration')
      .set('authorization', `Bearer ${firstNodeCredential.secret}`)
      .expect(200);
    expect(revoked.body.grants[0].dataPlaneCredential).toBeNull();
  });

  it('returns only the authenticated node lifecycle snapshot', async () => {
    const prisma = app.get(PrismaService);
    const credentials = app.get(NodeAgentCredentialService);
    const suffix = randomUUID();
    let userId: string | undefined;
    let deviceId: string | undefined;
    let nodeId: string | undefined;
    let otherNodeId: string | undefined;

    try {
      const user = await prisma.user.create({
        data: { telegramUserId: suffix.replaceAll('-', '') },
      });
      userId = user.id;
      const device = await prisma.device.create({
        data: {
          userId: user.id,
          subscriptionTokenHash: `snapshot-feed-hash-${suffix}`,
        },
      });
      deviceId = device.id;
      const [node, otherNode] = await prisma.$transaction([
        prisma.node.create({
          data: {
            name: `snapshot-${suffix}`,
            provider: 'integration-test',
            locationLabel: 'integration-test',
            status: 'HEALTHY',
            desiredConfigVersion: 1,
          },
        }),
        prisma.node.create({
          data: {
            name: `snapshot-other-${suffix}`,
            provider: 'integration-test',
            locationLabel: 'integration-test',
            status: 'HEALTHY',
            desiredConfigVersion: 1,
          },
        }),
      ]);
      nodeId = node.id;
      otherNodeId = otherNode.id;
      const expiresAt = new Date('2026-09-01T00:00:00.000Z');
      const [grant] = await prisma.$transaction([
        prisma.nodeAccessGrant.create({
          data: {
            nodeId: node.id,
            deviceId: device.id,
            dataPlaneCredentialHash: `snapshot-credential-hash-${suffix}`,
            expiresAt,
            desiredVersion: 1,
          },
        }),
        prisma.nodeAccessGrant.create({
          data: {
            nodeId: otherNode.id,
            deviceId: device.id,
            dataPlaneCredentialHash: `snapshot-other-credential-hash-${suffix}`,
            expiresAt,
            desiredVersion: 1,
          },
        }),
      ]);
      const syncJob = await prisma.nodeSyncJob.create({
        data: {
          nodeId: node.id,
          nodeAccessGrantId: grant.id,
          targetVersion: 1,
          idempotencyKey: `snapshot-sync-${suffix}`,
          status: 'SUCCEEDED',
          attempts: 1,
          completedAt: new Date(),
        },
      });
      const credential = await credentials.rotate(node.id);

      await request(app.getHttpServer())
        .post('/node-agent/v1/heartbeats')
        .expect(401);
      await request(app.getHttpServer())
        .post('/node-agent/v1/heartbeats')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(204);
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
      ).resolves.toMatchObject({
        lastHeartbeatAt: expect.any(Date),
        lastHealthCheckAt: null,
      });

      await request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .expect(401);
      const response = await request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(200);

      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.body).sort()).toEqual([
        'appliedConfigVersion',
        'desiredConfigVersion',
        'grants',
        'pendingAcknowledgement',
        'routes',
      ]);
      expect(Object.keys(response.body.grants[0]).sort()).toEqual([
        'appliedVersion',
        'dataPlaneCredential',
        'desiredVersion',
        'expiresAt',
        'id',
        'revokedAt',
        'status',
      ]);

      expect(nodeAgentConfigurationSnapshotSchema.parse(response.body)).toEqual(
        {
          desiredConfigVersion: 1,
          appliedConfigVersion: 0,
          pendingAcknowledgement: {
            nodeSyncJobId: syncJob.id,
            targetVersion: 1,
            snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
          grants: [
            {
              id: grant.id,
              status: 'PENDING',
              expiresAt: expiresAt.toISOString(),
              desiredVersion: 1,
              appliedVersion: 0,
              revokedAt: null,
              dataPlaneCredential: null,
            },
          ],
          routes: [],
        },
      );
      expect(response.body.grants[0]).not.toHaveProperty('deviceId');
      expect(response.body.grants[0]).not.toHaveProperty(
        'dataPlaneCredentialHash',
      );

      await expect(credentials.revoke(node.id)).resolves.toBe(true);
      await request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(401);
      await request(app.getHttpServer())
        .post('/node-agent/v1/heartbeats')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(401);
      const disabledNodeCredential = await credentials.rotate(node.id);

      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'DISABLED' },
      });
      await request(app.getHttpServer())
        .post('/node-agent/v1/heartbeats')
        .set('authorization', `Bearer ${disabledNodeCredential.secret}`)
        .expect(401);
      await request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${disabledNodeCredential.secret}`)
        .expect(401);
    } finally {
      if (nodeId) {
        await prisma.nodeAgentCredential.deleteMany({ where: { nodeId } });
        await prisma.nodeConfigDelivery.deleteMany({ where: { nodeId } });
        await prisma.nodeSyncJob.deleteMany({ where: { nodeId } });
        await prisma.nodeAccessGrant.deleteMany({ where: { nodeId } });
      }
      if (otherNodeId) {
        await prisma.nodeAccessGrant.deleteMany({
          where: { nodeId: otherNodeId },
        });
      }
      if (nodeId) {
        await prisma.node.delete({ where: { id: nodeId } });
      }
      if (otherNodeId) {
        await prisma.node.delete({ where: { id: otherNodeId } });
      }
      if (deviceId) {
        await prisma.device.delete({ where: { id: deviceId } });
      }
      if (userId) {
        await prisma.user.delete({ where: { id: userId } });
      }
    }
  });

  it('runs the local pull, simulated apply, and acknowledgement lifecycle', async () => {
    const prisma = app.get(PrismaService);
    const credentials = app.get(NodeAgentCredentialService);
    const orchestration = app.get(OrchestrationService);
    const suffix = randomUUID();
    const stateDirectory = await mkdtemp(
      join(tmpdir(), 'vpn-node-agent-integration-'),
    );

    try {
      const user = await prisma.user.create({
        data: {
          telegramUserId: `92${suffix.replaceAll('-', '').slice(0, 20)}`,
        },
      });
      const device = await prisma.device.create({
        data: {
          userId: user.id,
          subscriptionTokenHash: `node-agent-runner-feed-${suffix}`,
        },
      });
      const node = await prisma.node.create({
        data: {
          name: `node-agent-runner-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
          desiredConfigVersion: 1,
        },
      });
      const grant = await prisma.nodeAccessGrant.create({
        data: {
          nodeId: node.id,
          deviceId: device.id,
          dataPlaneCredentialHash: `node-agent-runner-credential-${suffix}`,
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          desiredVersion: 1,
        },
      });
      const syncJob = await prisma.nodeSyncJob.create({
        data: {
          nodeId: node.id,
          nodeAccessGrantId: grant.id,
          targetVersion: 1,
          idempotencyKey: `node-agent-runner-sync-${suffix}`,
        },
      });
      const leaseToken = await orchestration.claimNodeSyncJob(
        syncJob.id,
        `node-agent-runner-${suffix}`,
      );
      if (!leaseToken) throw new Error('Integration sync job was not claimed');
      await expect(
        orchestration.completeNodeSyncJob(
          syncJob.id,
          `node-agent-runner-${suffix}`,
          leaseToken,
        ),
      ).resolves.toBe(true);
      const credential = await credentials.rotate(node.id);

      const server = app.getHttpServer() as { listening?: boolean };
      if (!server.listening) await app.listen(0, '127.0.0.1');
      const statePath = join(stateDirectory, 'state.json');
      const runner = new NodeAgentRunner(
        new HttpNodeAgentControlPlane(
          await app.getUrl(),
          credential.secret,
          5_000,
        ),
        new StateFileSimulationAdapter(statePath),
      );

      await expect(runner.runCycle()).resolves.toBe('acknowledged');
      await expect(runner.runCycle()).resolves.toBe('synchronized');
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
      ).resolves.toMatchObject({
        desiredConfigVersion: 1,
        appliedConfigVersion: 1,
        lastHeartbeatAt: expect.any(Date),
      });
      await expect(
        prisma.nodeAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
      ).resolves.toMatchObject({ desiredVersion: 1, appliedVersion: 1 });
      await expect(
        prisma.nodeConfigAcknowledgement.findUniqueOrThrow({
          where: { nodeSyncJobId: syncJob.id },
        }),
      ).resolves.toMatchObject({ nodeId: node.id, targetVersion: 1 });
      expect(await readFile(statePath, 'utf8')).not.toContain(
        credential.secret,
      );
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it('persists isolated device access data and rejects a duplicate feed token hash', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const telegramUserId = suffix.replaceAll('-', '');
    const planCode = `integration-${suffix}`;
    const tokenHash = `feed-hash-${suffix}`;
    let userId: string | undefined;
    let planId: string | undefined;
    let deviceId: string | undefined;
    let scheduledDeviceId: string | undefined;
    let failedScheduledDeviceId: string | undefined;
    let nodeId: string | undefined;
    let unrelatedNodeId: string | undefined;
    let nodeAccessGrantId: string | undefined;
    let nodeSyncJobId: string | undefined;
    let outboxEventId: string | undefined;
    let conflictingOutboxEventId: string | undefined;

    try {
      await expect(
        prisma.plan.create({
          data: {
            code: `invalid-plan-${suffix}`,
            name: 'Invalid integration plan',
            priceMinor: 0,
            currency: 'RUB',
            deviceLimit: 1,
          },
        }),
      ).rejects.toThrow('Plan_priceMinor_positive');

      const plan = await prisma.plan.create({
        data: {
          code: planCode,
          name: 'Integration plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 1,
        },
      });
      planId = plan.id;

      const user = await prisma.user.create({
        data: { telegramUserId },
      });
      userId = user.id;

      await expect(
        prisma.subscription.create({
          data: {
            userId: user.id,
            planId: plan.id,
            status: 'ACTIVE',
          },
        }),
      ).rejects.toThrow('Subscription_active_has_access_period');

      await prisma.subscription.create({
        data: {
          userId: user.id,
          planId: plan.id,
          status: 'ACTIVE',
          startsAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      await expect(
        prisma.subscription.create({
          data: {
            userId: user.id,
            planId: plan.id,
            status: 'ACTIVE',
            startsAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      await expect(
        prisma.subscription.create({
          data: {
            userId: user.id,
            planId: plan.id,
            status: 'PENDING',
            cancelledAt: new Date(),
          },
        }),
      ).rejects.toThrow('Subscription_cancelledAt_matches_status');

      await expect(
        prisma.device.create({
          data: {
            userId: user.id,
            status: 'REVOKED',
            subscriptionTokenHash: `invalid-device-token-${suffix}`,
          },
        }),
      ).rejects.toThrow('Device_revoked_has_timestamp');

      const device = await prisma.device.create({
        data: {
          userId: user.id,
          displayName: 'Integration device',
          subscriptionTokenHash: tokenHash,
        },
      });
      deviceId = device.id;

      const scheduledDevice = await prisma.device.create({
        data: {
          userId: user.id,
          displayName: 'Scheduled integration device',
          subscriptionTokenHash: `scheduled-feed-hash-${suffix}`,
        },
      });
      scheduledDeviceId = scheduledDevice.id;

      const node = await prisma.node.create({
        data: {
          name: `integration-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      });
      nodeId = node.id;

      await expect(
        prisma.node.update({
          where: { id: node.id },
          data: { appliedConfigVersion: 1 },
        }),
      ).rejects.toThrow(
        'Node appliedConfigVersion requires an acknowledgement',
      );

      const orchestration = app.get(OrchestrationService);
      const scheduled = await orchestration.scheduleNodeAccessGrant({
        nodeId: node.id,
        deviceId: scheduledDevice.id,
        expiresAt: new Date(Date.now() + 60_000),
        syncJobIdempotencyKey: `scheduled-sync-${suffix}`,
        outboxEventIdempotencyKey: `scheduled-outbox-${suffix}`,
      });
      await expect(
        orchestration.scheduleNodeAccessGrant({
          nodeId: node.id,
          deviceId: scheduledDevice.id,
          expiresAt: new Date(Date.now() + 60_000),
          syncJobIdempotencyKey: `scheduled-sync-${suffix}`,
          outboxEventIdempotencyKey: `scheduled-outbox-${suffix}`,
        }),
      ).resolves.toEqual(scheduled);
      expect(scheduled.targetVersion).toBe(1);
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
      ).resolves.toMatchObject({ desiredConfigVersion: 1 });
      await expect(
        prisma.nodeSyncJob.findUniqueOrThrow({
          where: { id: scheduled.nodeSyncJobId },
        }),
      ).resolves.toMatchObject({
        nodeAccessGrantId: scheduled.nodeAccessGrantId,
        targetVersion: 1,
        status: 'PENDING',
      });
      await expect(
        prisma.outboxEvent.findUniqueOrThrow({
          where: { id: scheduled.outboxEventId },
        }),
      ).resolves.toMatchObject({
        aggregateId: scheduled.nodeAccessGrantId,
        status: 'PENDING',
      });

      const failedScheduledDevice = await prisma.device.create({
        data: {
          userId: user.id,
          displayName: 'Failed scheduled integration device',
          subscriptionTokenHash: `failed-scheduled-feed-hash-${suffix}`,
        },
      });
      failedScheduledDeviceId = failedScheduledDevice.id;
      const conflictingOutboxEvent = await prisma.outboxEvent.create({
        data: {
          topic: 'node-sync.requested',
          aggregateType: 'NodeAccessGrant',
          aggregateId: scheduled.nodeAccessGrantId,
          payload: { nodeAccessGrantId: scheduled.nodeAccessGrantId },
          idempotencyKey: `conflicting-outbox-${suffix}`,
        },
      });
      conflictingOutboxEventId = conflictingOutboxEvent.id;
      await expect(
        orchestration.scheduleNodeAccessGrant({
          nodeId: node.id,
          deviceId: failedScheduledDevice.id,
          expiresAt: new Date(Date.now() + 60_000),
          syncJobIdempotencyKey: `failed-scheduled-sync-${suffix}`,
          outboxEventIdempotencyKey: `conflicting-outbox-${suffix}`,
        }),
      ).rejects.toThrow('Idempotency key does not match the requested grant');
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
      ).resolves.toMatchObject({ desiredConfigVersion: 1 });
      await expect(
        prisma.nodeAccessGrant.count({
          where: { deviceId: failedScheduledDevice.id },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.nodeSyncJob.findUnique({
          where: { idempotencyKey: `failed-scheduled-sync-${suffix}` },
        }),
      ).resolves.toBeNull();

      const unrelatedNode = await prisma.node.create({
        data: {
          name: `integration-unrelated-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      });
      unrelatedNodeId = unrelatedNode.id;

      const grant = await prisma.nodeAccessGrant.create({
        data: {
          nodeId: node.id,
          deviceId: device.id,
          dataPlaneCredentialHash: `credential-hash-${suffix}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      nodeAccessGrantId = grant.id;

      await expect(
        prisma.nodeAccessGrant.update({
          where: { id: grant.id },
          data: { status: 'ACTIVE', revokedAt: new Date() },
        }),
      ).rejects.toThrow('NodeAccessGrant_active_has_no_revocation_timestamp');

      await expect(
        prisma.nodeAccessGrant.update({
          where: { id: grant.id },
          data: { status: 'REVOKED' },
        }),
      ).rejects.toThrow('NodeAccessGrant_revoked_has_timestamp');

      await expect(
        prisma.nodeSyncJob.create({
          data: {
            nodeId: node.id,
            nodeAccessGrantId: grant.id,
            targetVersion: 0,
            attempts: -1,
            idempotencyKey: `invalid-attempts-${suffix}`,
          },
        }),
      ).rejects.toThrow('NodeSyncJob_attempts_nonnegative');

      await expect(
        prisma.nodeSyncJob.create({
          data: {
            nodeId: node.id,
            nodeAccessGrantId: grant.id,
            targetVersion: 1,
            status: 'SUCCEEDED',
            idempotencyKey: `invalid-succeeded-${suffix}`,
          },
        }),
      ).rejects.toThrow('NodeSyncJob_terminal_has_completion_timestamp');

      await expect(
        prisma.nodeSyncJob.create({
          data: {
            nodeId: node.id,
            nodeAccessGrantId: grant.id,
            targetVersion: 1,
            status: 'PROCESSING',
            leaseOwner: 'worker-a',
            leaseToken: randomUUID(),
            leaseExpiresAt: new Date(Date.now() + 60_000),
            nextAttemptAt: new Date(Date.now() + 60_000),
            idempotencyKey: `invalid-processing-retry-${suffix}`,
          },
        }),
      ).rejects.toThrow('NodeSyncJob_retry_scheduled_only_while_pending');

      await expect(
        prisma.nodeSyncJob.create({
          data: {
            nodeId: node.id,
            nodeAccessGrantId: grant.id,
            targetVersion: 1,
            status: 'FAILED',
            idempotencyKey: `invalid-failed-${suffix}`,
          },
        }),
      ).rejects.toThrow('NodeSyncJob_terminal_has_completion_timestamp');

      const syncJob = await prisma.nodeSyncJob.create({
        data: {
          nodeId: node.id,
          nodeAccessGrantId: grant.id,
          targetVersion: 1,
          idempotencyKey: `sync-${suffix}`,
        },
      });
      nodeSyncJobId = syncJob.id;

      await expect(
        prisma.nodeSyncJob.create({
          data: {
            nodeId: unrelatedNode.id,
            nodeAccessGrantId: grant.id,
            targetVersion: 1,
            idempotencyKey: `invalid-sync-${suffix}`,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });

      const outboxEvent = await prisma.outboxEvent.create({
        data: {
          topic: 'node-sync.requested',
          aggregateType: 'NodeAccessGrant',
          aggregateId: grant.id,
          payload: { nodeAccessGrantId: grant.id },
          idempotencyKey: `outbox-${suffix}`,
        },
      });
      outboxEventId = outboxEvent.id;

      await expect(
        prisma.outboxEvent.create({
          data: {
            topic: 'node-sync.published',
            aggregateType: 'NodeAccessGrant',
            aggregateId: grant.id,
            payload: { nodeAccessGrantId: grant.id },
            status: 'PUBLISHED',
            idempotencyKey: `invalid-published-${suffix}`,
          },
        }),
      ).rejects.toThrow('OutboxEvent_published_has_publication_timestamp');

      await expect(
        prisma.outboxEvent.create({
          data: {
            topic: 'node-sync.processing',
            aggregateType: 'NodeAccessGrant',
            aggregateId: grant.id,
            payload: { nodeAccessGrantId: grant.id },
            status: 'PROCESSING',
            leaseOwner: 'worker-a',
            leaseToken: randomUUID(),
            leaseExpiresAt: new Date(Date.now() + 60_000),
            nextAttemptAt: new Date(Date.now() + 60_000),
            idempotencyKey: `invalid-processing-retry-outbox-${suffix}`,
          },
        }),
      ).rejects.toThrow('OutboxEvent_retry_scheduled_only_while_pending');

      const auditEvent = await prisma.auditEvent.create({
        data: {
          action: 'node-access-grant.created',
          entityType: 'NodeAccessGrant',
          entityId: grant.id,
        },
      });

      await expect(
        prisma.auditEvent.update({
          where: { id: auditEvent.id },
          data: { action: 'node-access-grant.updated' },
        }),
      ).rejects.toThrow('AuditEvent is append-only');

      await expect(
        prisma.auditEvent.delete({ where: { id: auditEvent.id } }),
      ).rejects.toThrow('AuditEvent is append-only');

      await expect(
        prisma.device.create({
          data: {
            userId: user.id,
            subscriptionTokenHash: tokenHash,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    } finally {
      if (nodeSyncJobId) {
        await prisma.nodeSyncJob.delete({ where: { id: nodeSyncJobId } });
      }
      if (outboxEventId) {
        await prisma.outboxEvent.delete({ where: { id: outboxEventId } });
      }
      if (nodeAccessGrantId) {
        await prisma.nodeAccessGrant.delete({
          where: { id: nodeAccessGrantId },
        });
      }
      if (scheduledDeviceId) {
        await prisma.nodeSyncJob.deleteMany({
          where: { idempotencyKey: `scheduled-sync-${suffix}` },
        });
        await prisma.outboxEvent.deleteMany({
          where: { idempotencyKey: `scheduled-outbox-${suffix}` },
        });
        await prisma.nodeAccessGrant.deleteMany({
          where: { deviceId: scheduledDeviceId },
        });
        await prisma.device.delete({ where: { id: scheduledDeviceId } });
      }
      if (conflictingOutboxEventId) {
        await prisma.outboxEvent.delete({
          where: { id: conflictingOutboxEventId },
        });
      }
      if (failedScheduledDeviceId) {
        await prisma.device.delete({ where: { id: failedScheduledDeviceId } });
      }
      if (deviceId) {
        await prisma.device.delete({ where: { id: deviceId } });
      }
      if (nodeId) {
        await prisma.node.delete({ where: { id: nodeId } });
      }
      if (unrelatedNodeId) {
        await prisma.node.delete({ where: { id: unrelatedNodeId } });
      }
      if (userId) {
        await prisma.subscription.deleteMany({ where: { userId } });
        await prisma.user.delete({ where: { id: userId } });
      }
      if (planId) {
        await prisma.plan.delete({ where: { id: planId } });
      }
    }
  });

  it('returns only the authenticated user cabinet overview', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const sessionPepper = process.env.AUTH_SESSION_PEPPER;
    const firstSecret = 'a'.repeat(43);
    const secondSecret = 'b'.repeat(43);
    let planId: string | undefined;
    let firstUserId: string | undefined;
    let secondUserId: string | undefined;

    if (!sessionPepper) {
      throw new Error(
        'AUTH_SESSION_PEPPER is required for this integration test',
      );
    }
    const hashSession = (secret: string) =>
      createHmac('sha256', sessionPepper).update(secret).digest('hex');

    try {
      const plan = await prisma.plan.create({
        data: {
          code: `cabinet-${suffix}`,
          name: 'Cabinet integration plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 3,
        },
      });
      planId = plan.id;
      const [firstUser, secondUser] = await prisma.$transaction([
        prisma.user.create({
          data: {
            telegramUserId: `1${suffix.replaceAll('-', '').slice(0, 20)}`,
          },
        }),
        prisma.user.create({
          data: {
            telegramUserId: `2${suffix.replaceAll('-', '').slice(0, 20)}`,
          },
        }),
      ]);
      firstUserId = firstUser.id;
      secondUserId = secondUser.id;
      await prisma.$transaction([
        prisma.subscription.create({
          data: {
            userId: firstUser.id,
            planId: plan.id,
            status: 'ACTIVE',
            startsAt: new Date('2026-08-01T00:00:00.000Z'),
            expiresAt: new Date('2026-09-01T00:00:00.000Z'),
          },
        }),
        prisma.device.create({
          data: {
            userId: firstUser.id,
            displayName: 'First user laptop',
            platform: 'windows',
            subscriptionTokenHash: `cabinet-first-device-${suffix}`,
          },
        }),
        prisma.device.create({
          data: {
            userId: secondUser.id,
            displayName: 'Second user phone',
            platform: 'android',
            subscriptionTokenHash: `cabinet-second-device-${suffix}`,
          },
        }),
        prisma.userSession.create({
          data: {
            userId: firstUser.id,
            tokenHash: hashSession(firstSecret),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
        prisma.userSession.create({
          data: {
            userId: secondUser.id,
            tokenHash: hashSession(secondSecret),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ]);

      await request(app.getHttpServer()).get('/cabinet/overview').expect(401);
      const response = await request(app.getHttpServer())
        .get('/cabinet/overview')
        .set('cookie', `vpn_platform_session=${firstSecret}`)
        .expect(200);

      expect(cabinetOverviewSchema.parse(response.body)).toEqual({
        subscription: {
          status: 'ACTIVE',
          planName: 'Cabinet integration plan',
          deviceLimit: 3,
          startsAt: '2026-08-01T00:00:00.000Z',
          expiresAt: '2026-09-01T00:00:00.000Z',
        },
        devices: [
          expect.objectContaining({
            displayName: 'First user laptop',
            platform: 'windows',
            status: 'ACTIVE',
          }),
        ],
      });
      expect(JSON.stringify(response.body)).not.toContain('Second user phone');
      expect(JSON.stringify(response.body)).not.toContain(
        `cabinet-first-device-${suffix}`,
      );
    } finally {
      if (firstUserId || secondUserId) {
        const userIds = [firstUserId, secondUserId].filter(
          (id): id is string => id !== undefined,
        );
        await prisma.userSession.deleteMany({
          where: { userId: { in: userIds } },
        });
        await prisma.device.deleteMany({
          where: { userId: { in: userIds } },
        });
        await prisma.subscription.deleteMany({
          where: { userId: { in: userIds } },
        });
        await prisma.user.deleteMany({
          where: { id: { in: userIds } },
        });
      }
      if (planId) {
        await prisma.plan.delete({ where: { id: planId } });
      }
    }
  });

  it('returns one device and the same URL when a device issuance request is retried', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const sessionPepper = process.env.AUTH_SESSION_PEPPER;
    const secret = 'e'.repeat(43);
    const idempotencyKey = randomUUID();
    let subscriptionId: string | undefined;
    let planId: string | undefined;
    let userId: string | undefined;

    if (!sessionPepper) {
      throw new Error(
        'AUTH_SESSION_PEPPER is required for this integration test',
      );
    }

    try {
      const plan = await prisma.plan.create({
        data: {
          code: `issuance-${suffix}`,
          name: 'Issuance integration plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 1,
        },
      });
      planId = plan.id;
      const user = await prisma.user.create({
        data: { telegramUserId: `4${suffix.replaceAll('-', '').slice(0, 20)}` },
      });
      userId = user.id;
      const [subscription] = await prisma.$transaction([
        prisma.subscription.create({
          data: {
            userId: user.id,
            planId: plan.id,
            status: 'ACTIVE',
            startsAt: new Date('2026-08-01T00:00:00.000Z'),
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          },
        }),
        prisma.userSession.create({
          data: {
            userId: user.id,
            tokenHash: createHmac('sha256', sessionPepper)
              .update(secret)
              .digest('hex'),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ]);
      subscriptionId = subscription.id;

      const issue = () =>
        request(app.getHttpServer())
          .post('/cabinet/devices')
          .set('cookie', `vpn_platform_session=${secret}`)
          .set('origin', 'https://app.example.test')
          .set('idempotency-key', idempotencyKey)
          .send({ displayName: 'Retry-safe laptop' });
      const [first, retry] = await Promise.all([issue(), issue()]);

      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(issuedCabinetDeviceSchema.parse(first.body)).toEqual(
        issuedCabinetDeviceSchema.parse(retry.body),
      );
      expect(
        await prisma.device.count({ where: { userId, status: 'ACTIVE' } }),
      ).toBe(1);

      await prisma.subscription.update({
        where: { id: subscriptionId },
        data: { expiresAt: new Date('2026-08-11T00:00:00.000Z') },
      });
      await issue()
        .set('idempotency-key', randomUUID())
        .send({ displayName: 'Must not be issued after expiry' })
        .expect(409);
      expect(
        await prisma.device.count({ where: { userId, status: 'ACTIVE' } }),
      ).toBe(1);
    } finally {
      if (userId) {
        await prisma.userSession.deleteMany({ where: { userId } });
        await prisma.device.deleteMany({ where: { userId } });
        await prisma.subscription.deleteMany({ where: { userId } });
      }
      if (planId) {
        await prisma.plan.delete({ where: { id: planId } });
      }
    }
  });

  it('serializes different device issuance keys at a one-device limit', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const sessionPepper = process.env.AUTH_SESSION_PEPPER;
    const secret = '9'.repeat(43);
    let planId: string | undefined;
    let userId: string | undefined;

    if (!sessionPepper) {
      throw new Error(
        'AUTH_SESSION_PEPPER is required for this integration test',
      );
    }

    try {
      const plan = await prisma.plan.create({
        data: {
          code: `issuance-race-${suffix}`,
          name: 'Issuance race integration plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 1,
        },
      });
      planId = plan.id;
      const user = await prisma.user.create({
        data: { telegramUserId: `7${suffix.replaceAll('-', '').slice(0, 20)}` },
      });
      userId = user.id;
      await prisma.subscription.create({
        data: {
          userId: user.id,
          planId: plan.id,
          status: 'ACTIVE',
          startsAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await prisma.userSession.create({
        data: {
          userId: user.id,
          tokenHash: createHmac('sha256', sessionPepper)
            .update(secret)
            .digest('hex'),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const firstKey = randomUUID();
      const secondKey = randomUUID();
      const attempts = [
        { key: firstKey, displayName: 'Concurrent first' },
        { key: secondKey, displayName: 'Concurrent second' },
      ];
      const issue = (attempt: (typeof attempts)[number]) =>
        request(app.getHttpServer())
          .post('/cabinet/devices')
          .set('cookie', `vpn_platform_session=${secret}`)
          .set('origin', 'https://app.example.test')
          .set('idempotency-key', attempt.key)
          .send({ displayName: attempt.displayName });
      const responses = await Promise.all(attempts.map(issue));
      expect(responses.map((response) => response.status).sort()).toEqual([
        201, 409,
      ]);
      expect(
        await prisma.device.count({
          where: { userId: user.id, status: 'ACTIVE' },
        }),
      ).toBe(1);
      expect(
        await prisma.auditEvent.count({
          where: { actorUserId: user.id, action: 'device.issued' },
        }),
      ).toBe(1);

      const winnerIndex = responses.findIndex(
        (response) => response.status === 201,
      );
      if (winnerIndex < 0) {
        throw new Error('One concurrent issuance must succeed');
      }
      const winner = issuedCabinetDeviceSchema.parse(
        responses[winnerIndex]?.body,
      );
      const retry = await issue(
        attempts[winnerIndex] as (typeof attempts)[number],
      );
      expect(retry.status).toBe(201);
      expect(issuedCabinetDeviceSchema.parse(retry.body)).toEqual(winner);
      expect(JSON.stringify(retry.body)).toContain(winner.subscriptionUrl);
      expect(
        await prisma.device.count({
          where: { userId: user.id, status: 'ACTIVE' },
        }),
      ).toBe(1);
      expect(
        await prisma.auditEvent.count({
          where: { actorUserId: user.id, action: 'device.issued' },
        }),
      ).toBe(1);
    } finally {
      if (userId) {
        await prisma.userSession.deleteMany({ where: { userId } });
        await prisma.device.deleteMany({ where: { userId } });
        await prisma.subscription.deleteMany({ where: { userId } });
        // The audit record is append-only and deliberately retains its actor.
      }
      if (planId) await prisma.plan.deleteMany({ where: { id: planId } });
    }
  });

  it('rejects device issuance if the subscription expires while its advisory lock is held', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const sessionPepper = process.env.AUTH_SESSION_PEPPER;
    const secret = 'f'.repeat(43);
    const expiresAt = new Date(Date.now() + 1_500);
    let planId: string | undefined;
    let userId: string | undefined;
    let releaseLock: (() => void) | undefined;
    let heldLock: Promise<void> | undefined;

    if (!sessionPepper) {
      throw new Error(
        'AUTH_SESSION_PEPPER is required for this integration test',
      );
    }

    try {
      const plan = await prisma.plan.create({
        data: {
          code: `issuance-expiry-${suffix}`,
          name: 'Issuance expiry integration plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 1,
        },
      });
      planId = plan.id;
      const user = await prisma.user.create({
        data: { telegramUserId: `5${suffix.replaceAll('-', '').slice(0, 20)}` },
      });
      userId = user.id;
      await prisma.$transaction([
        prisma.subscription.create({
          data: {
            userId: user.id,
            planId: plan.id,
            status: 'ACTIVE',
            startsAt: new Date(),
            expiresAt,
          },
        }),
        prisma.userSession.create({
          data: {
            userId: user.id,
            tokenHash: createHmac('sha256', sessionPepper)
              .update(secret)
              .digest('hex'),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ]);

      let signalLockAcquired: (() => void) | undefined;
      const lockAcquired = new Promise<void>((resolve) => {
        signalLockAcquired = resolve;
      });
      heldLock = prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(${`cabinet-device:${user.id}`}))
        `;
        signalLockAcquired?.();
        await new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
      });
      await lockAcquired;

      const issuance = request(app.getHttpServer())
        .post('/cabinet/devices')
        .set('cookie', `vpn_platform_session=${secret}`)
        .set('origin', 'https://app.example.test')
        .set('idempotency-key', randomUUID())
        .send({ displayName: 'Expired while waiting' });
      const issuanceResponse = issuance.then((response) => response);

      let waitingForLock = false;
      for (let attempts = 0; attempts < 40; attempts += 1) {
        const [lock] = await prisma.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1
            FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
          ) AS waiting
        `;
        if (lock?.waiting) {
          waitingForLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waitingForLock).toBe(true);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 50)),
      );
      releaseLock?.();
      releaseLock = undefined;
      await heldLock;

      expect((await issuanceResponse).status).toBe(409);
      await expect(
        prisma.device.count({ where: { userId: user.id } }),
      ).resolves.toBe(0);
    } finally {
      releaseLock?.();
      await heldLock;
      if (userId) {
        await prisma.userSession.deleteMany({ where: { userId } });
        await prisma.device.deleteMany({ where: { userId } });
        await prisma.subscription.deleteMany({ where: { userId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
      if (planId) {
        await prisma.plan.delete({ where: { id: planId } });
      }
    }
  });

  it('revokes one owned device and schedules each affected node exactly once', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const sessionPepper = process.env.AUTH_SESSION_PEPPER;
    const ownerSecret = createHash('sha256')
      .update(`revocation-owner:${suffix}`)
      .digest('base64url');
    const otherSecret = createHash('sha256')
      .update(`revocation-other:${suffix}`)
      .digest('base64url');
    if (!sessionPepper) {
      throw new Error(
        'AUTH_SESSION_PEPPER is required for this integration test',
      );
    }

    const [owner, otherUser] = await prisma.$transaction([
      prisma.user.create({
        data: {
          telegramUserId: `81${suffix.replaceAll('-', '').slice(0, 20)}`,
        },
      }),
      prisma.user.create({
        data: {
          telegramUserId: `82${suffix.replaceAll('-', '').slice(0, 20)}`,
        },
      }),
    ]);
    await prisma.$transaction([
      prisma.userSession.create({
        data: {
          userId: owner.id,
          tokenHash: createHmac('sha256', sessionPepper)
            .update(ownerSecret)
            .digest('hex'),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
      prisma.userSession.create({
        data: {
          userId: otherUser.id,
          tokenHash: createHmac('sha256', sessionPepper)
            .update(otherSecret)
            .digest('hex'),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ]);
    const device = await prisma.device.create({
      data: {
        userId: owner.id,
        displayName: 'Revocation integration device',
        subscriptionTokenHash: `revocation-feed-${suffix}`,
      },
    });
    const node = await prisma.node.create({
      data: {
        name: `revocation-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'HEALTHY',
      },
    });
    const grant = await prisma.nodeAccessGrant.create({
      data: {
        nodeId: node.id,
        deviceId: device.id,
        status: 'ACTIVE',
        dataPlaneCredentialHash: `revocation-credential-${suffix}`,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    const revoke = (secret: string) =>
      request(app.getHttpServer())
        .post(`/cabinet/devices/${device.id}/revoke`)
        .set('cookie', `vpn_platform_session=${secret}`)
        .set('origin', 'https://app.example.test');

    await revoke(otherSecret).expect(404);
    await expect(
      prisma.device.findUniqueOrThrow({ where: { id: device.id } }),
    ).resolves.toMatchObject({ status: 'ACTIVE', revokedAt: null });

    const responses = await Promise.all([
      revoke(ownerSecret),
      revoke(ownerSecret),
    ]);
    expect(responses.map((response) => response.status)).toEqual([204, 204]);

    const [revokedDevice, revokedGrant, updatedNode, syncJobs, outboxEvents] =
      await Promise.all([
        prisma.device.findUniqueOrThrow({ where: { id: device.id } }),
        prisma.nodeAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
        prisma.nodeSyncJob.findMany({ where: { nodeAccessGrantId: grant.id } }),
        prisma.outboxEvent.findMany({ where: { aggregateId: grant.id } }),
      ]);
    expect(revokedDevice.status).toBe('REVOKED');
    expect(revokedDevice.revokedAt).toBeInstanceOf(Date);
    expect(revokedGrant).toMatchObject({
      status: 'REVOKED',
      desiredVersion: 1,
    });
    expect(revokedGrant.revokedAt).toEqual(revokedDevice.revokedAt);
    expect(updatedNode.desiredConfigVersion).toBe(1);
    expect(syncJobs).toHaveLength(1);
    expect(syncJobs[0]).toMatchObject({
      nodeId: node.id,
      targetVersion: 1,
      status: 'PENDING',
    });
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0]).toMatchObject({
      topic: 'node-sync.requested',
      status: 'PENDING',
      payload: {
        nodeAccessGrantId: grant.id,
        nodeSyncJobId: syncJobs[0]?.id,
        targetVersion: 1,
      },
    });
    await expect(
      prisma.auditEvent.count({
        where: {
          actorUserId: owner.id,
          action: { in: ['device.revoked', 'node-access-grant.revoked'] },
        },
      }),
    ).resolves.toBe(2);
  });

  it('serves an empty feed only to an active device with an active subscription', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const token = 'c'.repeat(43);
    const pepper = process.env.SUBSCRIPTION_TOKEN_PEPPER;
    let planId: string | undefined;
    let userId: string | undefined;

    if (!pepper) {
      throw new Error(
        'SUBSCRIPTION_TOKEN_PEPPER is required for this integration test',
      );
    }

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
            subscriptionTokenHash: createHmac('sha256', pepper)
              .update(token)
              .digest('hex'),
          },
        }),
      ]);

      const response = await request(app.getHttpServer())
        .get(`/sub/${token}`)
        .expect('content-type', /text\/plain; charset=utf-8/)
        .expect(200);
      expect(subscriptionFeedSchema.parse(response.text)).toBe('');
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
    const pepper = process.env.SUBSCRIPTION_TOKEN_PEPPER;
    const suffix = randomUUID();
    const stateDirectory = await mkdtemp(
      join(tmpdir(), 'vpn-route-render-integration-'),
    );
    const statePath = join(stateDirectory, 'state.json');
    const token = `e${suffix.replaceAll('-', '')}${'x'.repeat(10)}`.slice(
      0,
      43,
    );
    if (!pepper) throw new Error('SUBSCRIPTION_TOKEN_PEPPER is required');
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
        subscriptionTokenHash: createHmac('sha256', pepper)
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
        orchestration,
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
      await expect(getFeed().expect(200)).resolves.toMatchObject({ text: '' });
      environment.SUBSCRIPTION_FEED_RENDERING_ENABLED = true;
      await expect(getFeed().expect(200)).resolves.toMatchObject({ text: '' });
      await deliverNodeConfig(
        app,
        orchestration,
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
      const expectEmpty = async () => {
        const empty = await getFeed().expect(200);
        expect(empty.text).toBe('');
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
      await expectEmpty();
      await restoreAppliedGrant();
      await prisma.nodeAccessGrant.update({
        where: { id: scheduled.nodeAccessGrantId },
        data: { appliedVersion: 0 },
      });
      await expectEmpty();
      await restoreAppliedGrant();
      await prisma.nodeAccessGrant.update({
        where: { id: scheduled.nodeAccessGrantId },
        data: { expiresAt: new Date('2000-01-01T00:00:00.000Z') },
      });
      await expectEmpty();
      await restoreAppliedGrant();
      await prisma.nodeAccessGrant.update({
        where: { id: scheduled.nodeAccessGrantId },
        data: { dataPlaneCredentialDerivationVersion: null },
      });
      await expectEmpty();
      await restoreAppliedGrant();
      await prisma.nodeAccessGrant.update({
        where: { id: scheduled.nodeAccessGrantId },
        data: { dataPlaneCredentialHash: `mismatch-${suffix}` },
      });
      await expectEmpty();
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
      await expectEmpty();
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
      await expectEmpty();
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
      await expectEmpty();
      await prisma.endpoint.update({
        where: { id: endpoint.id },
        data: { status: 'DISABLED' },
      });
      await expect(getFeed().expect(200)).resolves.toMatchObject({ text: '' });
    } finally {
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

    const unrelatedLeaseOwner = `unrelated-${suffix}`;
    const unrelatedLease = await orchestration.claimNodeSyncJob(
      unrelatedGrant.nodeSyncJobId,
      unrelatedLeaseOwner,
    );
    if (!unrelatedLease) throw new Error('Unrelated grant job was not claimed');
    await expect(
      orchestration.completeNodeSyncJob(
        unrelatedGrant.nodeSyncJobId,
        unrelatedLeaseOwner,
        unrelatedLease,
      ),
    ).resolves.toBe(true);
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

    const routeLeaseOwner = `route-${suffix}`;
    const routeLease = await orchestration.claimNodeSyncJob(
      publication.nodeSyncJobId,
      routeLeaseOwner,
    );
    if (!routeLease) throw new Error('Route job was not claimed');
    await expect(
      orchestration.completeNodeSyncJob(
        publication.nodeSyncJobId,
        routeLeaseOwner,
        routeLease,
      ),
    ).resolves.toBe(true);
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
      orchestration,
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
      orchestration,
      firstNodeCredential.secret,
      firstPublication.nodeSyncJobId,
      join(stateDirectory, 'first-node.json'),
    );
    await deliverNodeConfig(
      app,
      orchestration,
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
      orchestration,
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
      orchestration,
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
      orchestration,
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
