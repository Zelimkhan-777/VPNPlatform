import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  trialActivationSchema,
  type TrialActivation,
} from '@vpn-platform/contracts';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedBotRequest } from '../auth/bot-request-authentication.service';
import { BotRequestExecutionService } from '../auth/bot-request-execution.service';
import { PrismaService } from '../database/prisma.service';
import {
  DATA_PLANE_CREDENTIAL_DERIVATION_VERSION,
  DataPlaneCredentialService,
} from '../orchestration/data-plane-credential.service';
import { TrialActivationRateLimiterService } from './trial-activation-rate-limiter.service';

type TransactionClient = Prisma.TransactionClient;

type EligibleCampaign = {
  id: string;
  planId: string;
  durationDays: number;
  maxActivations: number | null;
  deviceLimit: number;
};

type ExistingActivation = {
  id: string;
  trialCampaignId: string;
  subscriptionId: string;
  planId: string;
  activatedAt: Date;
  startsAt: Date;
  expiresAt: Date;
};

type LockedGrant = {
  id: string;
  deviceId: string;
  status: 'PENDING' | 'ACTIVE' | 'REVOKED';
};

@Injectable()
export class TrialActivationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BotRequestExecutionService)
    private readonly botExecution: BotRequestExecutionService,
    @Inject(TrialActivationRateLimiterService)
    private readonly rateLimiter: TrialActivationRateLimiterService,
    @Inject(DataPlaneCredentialService)
    private readonly dataPlaneCredentials: DataPlaneCredentialService,
  ) {}

  async activate(request: AuthenticatedBotRequest): Promise<TrialActivation> {
    const result = await this.botExecution.execute(
      request,
      async (transaction) => {
        await this.rateLimiter.assertAllowed(
          request.principalId,
          request.telegramUserId,
        );
        return this.activateInTransaction(transaction, request.telegramUserId);
      },
    );
    return trialActivationSchema.parse(result.body);
  }

  private async activateInTransaction(
    transaction: TransactionClient,
    telegramUserId: string,
  ) {
    const user = await transaction.user.upsert({
      where: { telegramUserId },
      update: {},
      create: { telegramUserId },
      select: { id: true },
    });
    await transaction.$queryRaw`
      SELECT "id"
      FROM "User"
      WHERE "id" = CAST(${user.id} AS uuid)
      FOR UPDATE
    `;

    const existing = await this.findExistingActivation(transaction, user.id);
    if (existing) return { statusCode: 200, body: serialize(existing) };

    const databaseClock = await transaction.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS "now"
    `;
    const now = databaseClock[0]?.now;
    if (!now) {
      throw new ServiceUnavailableException('Trial activation is unavailable');
    }

    const subscriptions = await transaction.$queryRaw<
      { id: string; expiresAt: Date | null }[]
    >`
      SELECT "id", "expiresAt"
      FROM "Subscription"
      WHERE "userId" = CAST(${user.id} AS uuid)
        AND "status" = CAST('ACTIVE' AS "SubscriptionStatus")
      ORDER BY "id"
      FOR UPDATE
    `;
    if (
      subscriptions.some(
        (subscription) =>
          subscription.expiresAt !== null &&
          subscription.expiresAt.getTime() > now.getTime(),
      )
    ) {
      throw new ConflictException('Trial activation is unavailable');
    }
    if (subscriptions.length > 0) {
      await transaction.subscription.updateMany({
        where: { id: { in: subscriptions.map(({ id }) => id) } },
        data: { status: 'EXPIRED' },
      });
    }

    const campaigns = await transaction.$queryRaw<EligibleCampaign[]>`
      SELECT campaign."id",
             campaign."planId",
             campaign."durationDays",
             campaign."maxActivations",
             plan."deviceLimit"
      FROM "TrialCampaign" AS campaign
      INNER JOIN "Plan" AS plan ON plan."id" = campaign."planId"
      WHERE campaign."isActive" = true
        AND campaign."archivedAt" IS NULL
        AND (campaign."startsAt" IS NULL OR campaign."startsAt" <= ${now})
        AND (campaign."endsAt" IS NULL OR campaign."endsAt" > ${now})
        AND plan."isActive" = true
      ORDER BY campaign."id"
      LIMIT 2
      FOR UPDATE OF campaign, plan
    `;
    if (campaigns.length === 0) {
      throw new ConflictException('Trial activation is unavailable');
    }
    if (campaigns.length !== 1) {
      throw new ServiceUnavailableException('Trial activation is unavailable');
    }
    const campaign = campaigns[0]!;

    const activeDeviceCount = await transaction.device.count({
      where: { userId: user.id, status: 'ACTIVE' },
    });
    if (activeDeviceCount > campaign.deviceLimit) {
      throw new ConflictException('Trial activation is unavailable');
    }

    const activationCount = await transaction.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS "count"
      FROM "TrialActivation"
      WHERE "trialCampaignId" = CAST(${campaign.id} AS uuid)
    `;
    if (
      campaign.maxActivations !== null &&
      Number(activationCount[0]?.count ?? 0) >= campaign.maxActivations
    ) {
      throw new ConflictException('Trial activation is unavailable');
    }

    const expiry = await transaction.$queryRaw<{ expiresAt: Date }[]>`
      SELECT ${now}::timestamptz
             + (${campaign.durationDays} * INTERVAL '1 day') AS "expiresAt"
    `;
    const expiresAt = expiry[0]?.expiresAt;
    if (!expiresAt) {
      throw new ServiceUnavailableException('Trial activation is unavailable');
    }

    const subscription = await transaction.subscription.create({
      data: {
        userId: user.id,
        planId: campaign.planId,
        status: 'ACTIVE',
        startsAt: now,
        expiresAt,
      },
      select: { id: true },
    });
    const activationId = randomUUID();
    await transaction.$executeRaw`
      INSERT INTO "TrialActivation" (
        "id", "trialCampaignId", "userId", "subscriptionId", "planId",
        "durationDays", "activatedAt", "startsAt", "expiresAt"
      ) VALUES (
        CAST(${activationId} AS uuid), CAST(${campaign.id} AS uuid),
        CAST(${user.id} AS uuid), CAST(${subscription.id} AS uuid),
        CAST(${campaign.planId} AS uuid), ${campaign.durationDays}, ${now},
        ${now}, ${expiresAt}
      )
    `;

    await this.scheduleExistingDeviceAccess(transaction, {
      activationId,
      userId: user.id,
      expiresAt,
    });
    await transaction.auditEvent.create({
      data: {
        actorUserId: user.id,
        action: 'trial.activated',
        entityType: 'TrialActivation',
        entityId: activationId,
        metadata: {
          trialCampaignId: campaign.id,
          subscriptionId: subscription.id,
          planId: campaign.planId,
          durationDays: campaign.durationDays,
        },
      },
    });

    return {
      statusCode: 200,
      body: serialize({
        id: activationId,
        trialCampaignId: campaign.id,
        subscriptionId: subscription.id,
        planId: campaign.planId,
        activatedAt: now,
        startsAt: now,
        expiresAt,
      }),
    };
  }

  private async findExistingActivation(
    transaction: TransactionClient,
    userId: string,
  ): Promise<ExistingActivation | null> {
    const rows = await transaction.$queryRaw<ExistingActivation[]>`
      SELECT activation."id",
             activation."trialCampaignId",
             activation."subscriptionId",
             activation."planId",
             activation."activatedAt",
             activation."startsAt",
             activation."expiresAt"
      FROM "TrialActivation" AS activation
      INNER JOIN "Subscription" AS subscription
        ON subscription."id" = activation."subscriptionId"
       AND subscription."userId" = activation."userId"
       AND subscription."planId" = activation."planId"
      WHERE activation."userId" = CAST(${userId} AS uuid)
      FOR SHARE OF activation, subscription
    `;
    return rows[0] ?? null;
  }

  private async scheduleExistingDeviceAccess(
    transaction: TransactionClient,
    input: { activationId: string; userId: string; expiresAt: Date },
  ): Promise<void> {
    const devices = await transaction.$queryRaw<{ id: string }[]>`
      SELECT "id"
      FROM "Device"
      WHERE "userId" = CAST(${input.userId} AS uuid)
        AND "status" = CAST('ACTIVE' AS "DeviceStatus")
      ORDER BY "id"
      FOR UPDATE
    `;
    if (devices.length === 0) return;

    const nodes = await transaction.$queryRaw<
      { id: string; status: 'HEALTHY' | 'DRAINING' | 'DISABLED' }[]
    >`
      SELECT node."id", node."status"::text AS "status"
      FROM "Node" AS node
      WHERE node."status" = CAST('HEALTHY' AS "NodeStatus")
         OR (
           node."status" IN (
             CAST('DRAINING' AS "NodeStatus"),
             CAST('DISABLED' AS "NodeStatus")
           )
           AND EXISTS (
             SELECT 1
             FROM "NodeAccessGrant" AS access_grant
             INNER JOIN "Device" AS device ON device."id" = access_grant."deviceId"
             WHERE access_grant."nodeId" = node."id"
               AND device."userId" = CAST(${input.userId} AS uuid)
               AND access_grant."status" <> CAST('REVOKED' AS "NodeAccessGrantStatus")
           )
         )
      ORDER BY node."id"
      FOR UPDATE OF node
    `;

    for (const node of nodes) {
      const grants = await transaction.$queryRaw<LockedGrant[]>`
        SELECT access_grant."id",
               access_grant."deviceId",
               access_grant."status"::text AS "status"
        FROM "NodeAccessGrant" AS access_grant
        INNER JOIN "Device" AS device ON device."id" = access_grant."deviceId"
        WHERE access_grant."nodeId" = CAST(${node.id} AS uuid)
          AND device."userId" = CAST(${input.userId} AS uuid)
        ORDER BY access_grant."id"
        FOR UPDATE OF access_grant
      `;
      const grantsByDevice = new Map(
        grants.map((grant) => [grant.deviceId, grant]),
      );
      const eligibleDevices = devices.filter((device) => {
        const grant = grantsByDevice.get(device.id);
        return (
          grant?.status !== 'REVOKED' && (grant || node.status === 'HEALTHY')
        );
      });
      if (eligibleDevices.length === 0) continue;

      const updatedNode = await transaction.node.update({
        where: { id: node.id },
        data: { desiredConfigVersion: { increment: 1 } },
        select: { desiredConfigVersion: true },
      });
      const changedGrantIds: string[] = [];
      for (const device of eligibleDevices) {
        const grant = grantsByDevice.get(device.id);
        if (grant) {
          await transaction.nodeAccessGrant.update({
            where: { id: grant.id },
            data: {
              expiresAt: input.expiresAt,
              desiredVersion: updatedNode.desiredConfigVersion,
            },
          });
          changedGrantIds.push(grant.id);
          continue;
        }

        const grantId = randomUUID();
        const credential = this.dataPlaneCredentials.derive({
          grantId,
          deviceId: device.id,
          nodeId: node.id,
        });
        const created = await transaction.nodeAccessGrant.create({
          data: {
            id: grantId,
            nodeId: node.id,
            deviceId: device.id,
            status: 'PENDING',
            dataPlaneCredentialHash: this.dataPlaneCredentials.hash(credential),
            dataPlaneCredentialDerivationVersion:
              DATA_PLANE_CREDENTIAL_DERIVATION_VERSION,
            expiresAt: input.expiresAt,
            desiredVersion: updatedNode.desiredConfigVersion,
          },
          select: { id: true },
        });
        changedGrantIds.push(created.id);
      }

      const leadGrantId = changedGrantIds[0]!;
      const syncJob = await transaction.nodeSyncJob.create({
        data: {
          nodeId: node.id,
          nodeAccessGrantId: leadGrantId,
          targetVersion: updatedNode.desiredConfigVersion,
          idempotencyKey: `trial:${input.activationId}:${node.id}`,
        },
        select: { id: true },
      });
      await transaction.outboxEvent.create({
        data: {
          topic: 'node-sync.requested',
          aggregateType: 'NodeAccessGrant',
          aggregateId: leadGrantId,
          payload: {
            nodeAccessGrantId: leadGrantId,
            nodeSyncJobId: syncJob.id,
            targetVersion: updatedNode.desiredConfigVersion,
          },
          idempotencyKey: `trial-outbox:${input.activationId}:${node.id}`,
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorUserId: input.userId,
          action: 'trial.access-scheduled',
          entityType: 'TrialActivation',
          entityId: input.activationId,
          metadata: {
            nodeId: node.id,
            targetVersion: updatedNode.desiredConfigVersion,
            grantCount: changedGrantIds.length,
          },
        },
      });
    }
  }
}

function serialize(activation: ExistingActivation): TrialActivation {
  if (!activation.startsAt || !activation.expiresAt) {
    throw new ServiceUnavailableException('Trial activation is unavailable');
  }
  return {
    id: activation.id,
    trialCampaignId: activation.trialCampaignId,
    subscriptionId: activation.subscriptionId,
    planId: activation.planId,
    startsAt: activation.startsAt.toISOString(),
    expiresAt: activation.expiresAt.toISOString(),
    activatedAt: activation.activatedAt.toISOString(),
  };
}
