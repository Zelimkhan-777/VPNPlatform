import { createHmac, randomBytes } from 'node:crypto';

import {
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  issuedTelegramAuthChallengeSchema,
  type IssuedTelegramAuthChallenge,
} from '@vpn-platform/contracts';
import type { Prisma } from '@prisma/client';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import type { AuthenticatedBotRequest } from './bot-request-authentication.service';
import { BotRequestExecutionService } from './bot-request-execution.service';

const AUTH_CHALLENGE_TTL_MS = 120_000;

@Injectable()
export class BotAuthChallengeService {
  constructor(
    @Inject(BotRequestExecutionService)
    private readonly botExecution: BotRequestExecutionService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  async issue(
    request: AuthenticatedBotRequest,
  ): Promise<IssuedTelegramAuthChallenge> {
    const pepper = this.environment.AUTH_SESSION_PEPPER;
    if (!pepper) {
      throw new ServiceUnavailableException('Telegram login is unavailable');
    }

    const result = await this.botExecution.execute(
      request,
      async (transaction) => {
        const users = await transaction.$queryRaw<
          { id: string; telegramUserId: string }[]
        >`
          SELECT "id", "telegramUserId"
          FROM "User"
          WHERE "telegramUserId" = ${request.telegramUserId}
          FOR UPDATE
        `;
        const user = users[0];
        if (!user) {
          throw new ConflictException('Cabinet access is unavailable');
        }

        const databaseClock = await transaction.$queryRaw<{ now: Date }[]>`
          SELECT clock_timestamp() AS "now"
        `;
        const now = databaseClock[0]?.now;
        if (!now) {
          throw new ServiceUnavailableException(
            'Telegram login is unavailable',
          );
        }

        const entitlement = await transaction.$queryRaw<{ id: string }[]>`
          SELECT "id"
          FROM "Subscription"
          WHERE "userId" = CAST(${user.id} AS uuid)
            AND "status" <> CAST('PENDING' AS "SubscriptionStatus")
            AND "startsAt" IS NOT NULL
            AND "startsAt" <= ${now}
            AND "expiresAt" IS NOT NULL
          ORDER BY "id"
          LIMIT 1
          FOR SHARE
        `;
        if (entitlement.length !== 1) {
          throw new ConflictException('Cabinet access is unavailable');
        }

        const launchId = randomBytes(32).toString('base64url');
        const challengeSecret = randomBytes(32).toString('base64url');
        const expiresAt = new Date(now.getTime() + AUTH_CHALLENGE_TTL_MS);
        await transaction.authChallenge.create({
          data: {
            launchId,
            tokenHash: createHmac('sha256', pepper)
              .update(challengeSecret)
              .digest('hex'),
            userId: user.id,
            createdAt: now,
            expiresAt,
          },
        });

        return {
          statusCode: 201,
          body: { launchId, expiresAt: expiresAt.toISOString() },
        } satisfies {
          statusCode: number;
          body: Prisma.InputJsonObject;
        };
      },
    );
    return issuedTelegramAuthChallengeSchema.parse(result.body);
  }
}
