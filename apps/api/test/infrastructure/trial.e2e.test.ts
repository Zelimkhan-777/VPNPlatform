import type { INestApplication } from '@nestjs/common';
import {
  createBotRequestCanonicalString,
  trialActivationSchema,
} from '@vpn-platform/contracts';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provisionBotCredential } from '../../src/auth/bot-credential-lifecycle';
import {
  API_ENVIRONMENT,
  type ApiEnvironment,
} from '../../src/config/environment';
import { PrismaService } from '../../src/database/prisma.service';
import { botSigningKek, createInfrastructureTestApp } from './fixture';

type ProvisionedCredential = Awaited<ReturnType<typeof provisionBotCredential>>;

describe('infrastructure trial', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let credential: ProvisionedCredential;

  beforeAll(async () => {
    app = await createInfrastructureTestApp();
    prisma = app.get(PrismaService);
    credential = await provisionBotCredential(prisma, botSigningKek, {
      principalName: `trial-bot-${randomUUID()}`,
      reason: 'Trial integration test',
    });
  });

  afterAll(async () => {
    credential?.signingKey.fill(0);
    await app?.close();
  });

  it('rejects an unsigned browser-shaped request without mutation', async () => {
    const telegramUserId = uniqueTelegramId();
    const response = await request(app.getHttpServer())
      .post('/trial/activate')
      .send({ telegramUserId });
    expect(response.status).toBe(401);
    expect(await prisma.user.count({ where: { telegramUserId } })).toBe(0);
  });

  it('creates a free subscription without financial records and returns the same activation on retry', async () => {
    const telegramUserId = uniqueTelegramId();
    const { campaignId } = await createCampaign(prisma, { durationDays: 3 });

    const first = await postTrial(telegramUserId, 'trial-basic-1');
    expect(first.status).toBe(200);
    const parsed = trialActivationSchema.parse(first.body);
    expect(parsed.trialCampaignId).toBe(campaignId);
    expect(
      new Date(parsed.expiresAt).getTime() -
        new Date(parsed.startsAt).getTime(),
    ).toBe(3 * 24 * 60 * 60 * 1_000);

    const replay = await postTrial(telegramUserId, 'trial-basic-1');
    await prisma.subscription.update({
      where: { id: parsed.subscriptionId },
      data: {
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      },
    });
    const retryWithAnotherKey = await postTrial(
      telegramUserId,
      'trial-basic-2',
    );
    expect(replay.status).toBe(200);
    expect(retryWithAnotherKey.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(retryWithAnotherKey.body).toEqual(first.body);
    const user = await prisma.user.findUniqueOrThrow({
      where: { telegramUserId },
      select: { id: true },
    });
    expect(await countTrialActivations(prisma, user.id)).toBe(1);
    expect(
      await prisma.subscription.count({ where: { userId: user.id } }),
    ).toBe(1);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateType: 'TrialActivation', aggregateId: parsed.id },
      }),
    ).toBe(0);
    expect(
      await prisma.auditEvent.count({
        where: { entityType: 'TrialActivation', entityId: parsed.id },
      }),
    ).toBe(1);
  });

  it('rejects a user with an actually active subscription without consuming trial capacity', async () => {
    const telegramUserId = uniqueTelegramId();
    const user = await prisma.user.create({ data: { telegramUserId } });
    const { campaignId, planId } = await createCampaign(prisma, {
      durationDays: 1,
      maxActivations: 1,
    });
    await prisma.subscription.create({
      data: {
        userId: user.id,
        planId,
        status: 'ACTIVE',
        startsAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    expect(
      (await postTrial(telegramUserId, 'trial-active-subscription')).status,
    ).toBe(409);
    expect(await countTrialActivations(prisma, user.id)).toBe(0);
    expect(await countCampaignActivations(prisma, campaignId)).toBe(0);
  });

  it('serializes campaign capacity across different users', async () => {
    const { campaignId } = await createCampaign(prisma, {
      durationDays: 1,
      maxActivations: 1,
    });
    const responses = await Promise.all([
      postTrial(uniqueTelegramId(), 'trial-capacity-a'),
      postTrial(uniqueTelegramId(), 'trial-capacity-b'),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(await countCampaignActivations(prisma, campaignId)).toBe(1);
  });

  it('returns completed exact retries without spending a new trial attempt', async () => {
    const environment = app.get<ApiEnvironment>(API_ENVIRONMENT);
    const previousLimit = environment.TRIAL_ACTIVATION_RATE_LIMIT_MAX;
    environment.TRIAL_ACTIVATION_RATE_LIMIT_MAX = 1;
    try {
      const telegramUserId = uniqueTelegramId();
      await createCampaign(prisma, { durationDays: 1 });
      const first = await postTrial(telegramUserId, 'trial-rate-replay');
      const replay = await postTrial(telegramUserId, 'trial-rate-replay');
      const newAttempt = await postTrial(telegramUserId, 'trial-rate-new');

      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      expect(newAttempt.status).toBe(429);
    } finally {
      environment.TRIAL_ACTIVATION_RATE_LIMIT_MAX = previousLimit;
    }
  });

  it('fails closed when more than one campaign is eligible', async () => {
    await createCampaign(prisma, { durationDays: 1 });
    await createCampaign(prisma, {
      durationDays: 5,
      preserveExisting: true,
    });
    const telegramUserId = uniqueTelegramId();

    expect((await postTrial(telegramUserId, 'trial-ambiguous')).status).toBe(
      503,
    );
    expect(await prisma.user.count({ where: { telegramUserId } })).toBe(0);
  });

  it('rejects disabled, future and expired campaign states', async () => {
    const telegramUserId = uniqueTelegramId();
    const { campaignId } = await createCampaign(prisma, { durationDays: 3 });
    await prisma.$executeRaw`
      UPDATE "TrialCampaign"
      SET "isActive" = false, "updatedAt" = clock_timestamp()
      WHERE "id" = CAST(${campaignId} AS uuid)
    `;
    expect((await postTrial(telegramUserId, 'trial-disabled')).status).toBe(
      409,
    );

    await prisma.$executeRaw`
      UPDATE "TrialCampaign"
      SET "isActive" = true,
          "startsAt" = clock_timestamp() + INTERVAL '1 day',
          "endsAt" = NULL,
          "updatedAt" = clock_timestamp()
      WHERE "id" = CAST(${campaignId} AS uuid)
    `;
    expect((await postTrial(telegramUserId, 'trial-future')).status).toBe(409);

    await prisma.$executeRaw`
      UPDATE "TrialCampaign"
      SET "startsAt" = NULL,
          "endsAt" = clock_timestamp() - INTERVAL '1 day',
          "updatedAt" = clock_timestamp()
      WHERE "id" = CAST(${campaignId} AS uuid)
    `;
    expect((await postTrial(telegramUserId, 'trial-expired')).status).toBe(409);
    expect(await prisma.user.count({ where: { telegramUserId } })).toBe(0);
  });

  it('creates desired grants and node-sync outbox work for an existing active device', async () => {
    const telegramUserId = uniqueTelegramId();
    const user = await prisma.user.create({ data: { telegramUserId } });
    const { planId } = await createCampaign(prisma, { durationDays: 5 });
    await prisma.subscription.create({
      data: {
        userId: user.id,
        planId,
        status: 'EXPIRED',
        startsAt: new Date(Date.now() - 172_800_000),
        expiresAt: new Date(Date.now() - 86_400_000),
      },
    });
    const device = await prisma.device.create({
      data: {
        userId: user.id,
        subscriptionTokenHash: randomUUID(),
      },
    });
    const node = await prisma.node.create({
      data: {
        name: `trial-node-${randomUUID()}`,
        provider: 'test',
        locationLabel: 'test',
        status: 'HEALTHY',
      },
    });

    const response = await postTrial(telegramUserId, 'trial-device');
    expect(response.status).toBe(200);
    const activation = trialActivationSchema.parse(response.body);
    const grant = await prisma.nodeAccessGrant.findUniqueOrThrow({
      where: { nodeId_deviceId: { nodeId: node.id, deviceId: device.id } },
    });
    expect(grant.status).toBe('PENDING');
    expect(grant.expiresAt.toISOString()).toBe(activation.expiresAt);
    expect(grant.desiredVersion).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: {
          aggregateId: grant.id,
          topic: 'node-sync.requested',
        },
      }),
    ).toBe(1);
  });

  it('does not restore access when a device is revoked before the trial device lock', async () => {
    const telegramUserId = uniqueTelegramId();
    const user = await prisma.user.create({ data: { telegramUserId } });
    const { planId } = await createCampaign(prisma, { durationDays: 1 });
    await prisma.subscription.create({
      data: {
        userId: user.id,
        planId,
        status: 'EXPIRED',
        startsAt: new Date(Date.now() - 172_800_000),
        expiresAt: new Date(Date.now() - 86_400_000),
      },
    });
    const device = await prisma.device.create({
      data: { userId: user.id, subscriptionTokenHash: randomUUID() },
    });
    const node = await prisma.node.create({
      data: {
        name: `trial-revoke-race-${randomUUID()}`,
        provider: 'test',
        locationLabel: 'test',
        status: 'HEALTHY',
      },
    });
    let releaseRevoke: (() => void) | undefined;
    let signalRevokeLocked: (() => void) | undefined;
    const revokeLocked = new Promise<void>((resolve) => {
      signalRevokeLocked = resolve;
    });
    const heldRevoke = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT "id"
        FROM "Device"
        WHERE "id" = CAST(${device.id} AS uuid)
        FOR UPDATE
      `;
      await transaction.device.update({
        where: { id: device.id },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      signalRevokeLocked?.();
      await new Promise<void>((resolve) => {
        releaseRevoke = resolve;
      });
    });
    await revokeLocked;

    const activation = postTrial(telegramUserId, 'trial-revoke-race').then(
      (response) => response,
    );
    let waitingForDeviceLock = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const [waiting] = await prisma.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND query LIKE '%FROM "Device"%FOR UPDATE%'
        ) AS "waiting"
      `;
      if (waiting?.waiting) {
        waitingForDeviceLock = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!waitingForDeviceLock) {
      releaseRevoke?.();
      await heldRevoke;
    }
    expect(waitingForDeviceLock).toBe(true);
    releaseRevoke?.();
    await heldRevoke;

    const response = await activation;
    expect(response.status).toBe(200);
    const parsed = trialActivationSchema.parse(response.body);
    expect(
      await prisma.device.findUniqueOrThrow({ where: { id: device.id } }),
    ).toMatchObject({ status: 'REVOKED' });
    expect(
      await prisma.nodeAccessGrant.count({
        where: { deviceId: device.id, status: { not: 'REVOKED' } },
      }),
    ).toBe(0);
    expect(await prisma.nodeSyncJob.count({ where: { nodeId: node.id } })).toBe(
      0,
    );
    expect(
      await prisma.outboxEvent.count({
        where: { idempotencyKey: `trial-outbox:${parsed.id}:${node.id}` },
      }),
    ).toBe(0);
  });

  it('enforces duration, append-only activation and used-campaign immutability in PostgreSQL', async () => {
    const plan = await createPlan(prisma);
    await expect(
      insertCampaign(prisma, {
        planId: plan.id,
        durationDays: 2,
        maxActivations: null,
      }),
    ).rejects.toThrow();

    const telegramUserId = uniqueTelegramId();
    const { campaignId } = await createCampaign(prisma, { durationDays: 1 });
    const response = await postTrial(telegramUserId, 'trial-db-guards');
    expect(response.status).toBe(200);
    const activation = trialActivationSchema.parse(response.body);
    await expect(
      prisma.$executeRaw`
        UPDATE "TrialActivation"
        SET "durationDays" = 3
        WHERE "id" = CAST(${activation.id} AS uuid)
      `,
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRaw`
        UPDATE "TrialCampaign"
        SET "durationDays" = 3
        WHERE "id" = CAST(${campaignId} AS uuid)
      `,
    ).rejects.toThrow(/immutable/);
  });

  function postTrial(telegramUserId: string, idempotencyKey: string) {
    const rawBody = JSON.stringify({ telegramUserId });
    return databaseTimestamp().then((timestamp) => {
      const nonce = randomUUID().replaceAll('-', '');
      const canonical = {
        credentialId: credential.credentialId,
        method: 'POST',
        path: '/trial/activate',
        timestamp,
        nonce,
        telegramUserId,
        idempotencyKey,
        rawBodySha256: createHash('sha256').update(rawBody).digest('hex'),
      };
      return request(app.getHttpServer())
        .post('/trial/activate')
        .set('content-type', 'application/json')
        .set('x-bot-credential-id', credential.credentialId)
        .set('idempotency-key', idempotencyKey)
        .set('x-bot-timestamp', timestamp)
        .set('x-bot-nonce', nonce)
        .set(
          'x-bot-signature',
          createHmac('sha256', credential.signingKey)
            .update(createBotRequestCanonicalString(canonical))
            .digest('hex'),
        )
        .send(rawBody);
    });
  }

  async function databaseTimestamp(): Promise<string> {
    const rows = await prisma.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS "now"
    `;
    return String(Math.floor((rows[0]?.now.getTime() ?? 0) / 1_000));
  }
});

function uniqueTelegramId(): string {
  return `6${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
}

async function createPlan(prisma: PrismaService) {
  return prisma.plan.create({
    data: {
      code: `trial-${randomUUID()}`,
      name: 'Trial plan',
      priceMinor: 20_000,
      currency: 'RUB',
      durationDays: 30,
      deviceLimit: 3,
    },
  });
}

async function createCampaign(
  prisma: PrismaService,
  input: {
    durationDays: 1 | 3 | 5;
    maxActivations?: number;
    preserveExisting?: boolean;
  },
): Promise<{ campaignId: string; planId: string }> {
  if (!input.preserveExisting) {
    await prisma.$executeRaw`
      UPDATE "TrialCampaign"
      SET "isActive" = false, "updatedAt" = clock_timestamp()
      WHERE "isActive" = true
    `;
  }
  const plan = await createPlan(prisma);
  const campaignId = await insertCampaign(prisma, {
    planId: plan.id,
    durationDays: input.durationDays,
    maxActivations: input.maxActivations ?? null,
  });
  return { campaignId, planId: plan.id };
}

async function insertCampaign(
  prisma: PrismaService,
  input: {
    planId: string;
    durationDays: number;
    maxActivations: number | null;
  },
): Promise<string> {
  const campaignId = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "TrialCampaign" (
      "id", "planId", "durationDays", "maxActivations", "updatedAt"
    ) VALUES (
      CAST(${campaignId} AS uuid), CAST(${input.planId} AS uuid),
      ${input.durationDays}, ${input.maxActivations}, clock_timestamp()
    )
  `;
  return campaignId;
}

async function countTrialActivations(
  prisma: PrismaService,
  userId: string,
): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS "count"
    FROM "TrialActivation"
    WHERE "userId" = CAST(${userId} AS uuid)
  `;
  return Number(rows[0]?.count ?? 0);
}

async function countCampaignActivations(
  prisma: PrismaService,
  campaignId: string,
): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS "count"
    FROM "TrialActivation"
    WHERE "trialCampaignId" = CAST(${campaignId} AS uuid)
  `;
  return Number(rows[0]?.count ?? 0);
}
