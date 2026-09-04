import {
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';

import { PrismaService } from '../database/prisma.service';
import type { AuthenticatedBotRequest } from './bot-request-authentication.service';

export interface BotOperationResponse<
  Body extends Prisma.InputJsonValue = Prisma.InputJsonValue,
> {
  statusCode: number;
  body: Body;
}

export interface BotExecutionResult<
  Body extends Prisma.InputJsonValue = Prisma.InputJsonValue,
> extends BotOperationResponse<Body> {
  replayed: boolean;
}

type TransactionClient = Parameters<
  Parameters<PrismaClient['$transaction']>[0]
>[0];

@Injectable()
export class BotRequestExecutionService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The operation must keep its effects inside the supplied transaction. Queue
   * external work through a transactional outbox instead of performing it here.
   */
  execute<Body extends Prisma.InputJsonValue>(
    request: AuthenticatedBotRequest,
    operation: (
      transaction: TransactionClient,
    ) => Promise<BotOperationResponse<Body>>,
  ): Promise<BotExecutionResult<Body>> {
    return this.prisma.$transaction(async (transaction) => {
      const activeCredential = await transaction.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "BotServiceCredential"
        WHERE "id" = ${request.credentialId}::uuid
          AND "principalId" = ${request.principalId}::uuid
          AND "revokedAt" IS NULL
        FOR UPDATE
      `;
      if (activeCredential.length !== 1) {
        throw new UnauthorizedException('Bot request is invalid');
      }
      await transaction.$queryRaw`
        WITH acquired AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${idempotencyLockScope(request)},
              0
            )
          )
        )
        SELECT 1::integer AS "locked"
        FROM acquired
      `;
      const existing = await transaction.botRequestIdempotency.findFirst({
        where: idempotencyScope(request),
        select: {
          requestHash: true,
          responseStatus: true,
          responseBody: true,
          completedAt: true,
        },
      });
      if (existing) {
        if (existing.requestHash !== request.requestHash) {
          throw new ConflictException(
            'Idempotency key conflicts with another request',
          );
        }
        if (
          existing.completedAt === null ||
          existing.responseStatus === null ||
          existing.responseBody === null
        ) {
          throw new ServiceUnavailableException(
            'Bot request result is unavailable',
          );
        }
        return {
          statusCode: existing.responseStatus,
          body: existing.responseBody as Body,
          replayed: true,
        };
      }

      const pending = await transaction.botRequestIdempotency.create({
        data: {
          ...idempotencyScope(request),
          requestHash: request.requestHash,
        },
        select: { id: true },
      });
      const response = await operation(transaction);
      if (
        !Number.isInteger(response.statusCode) ||
        response.statusCode < 100 ||
        response.statusCode > 599
      ) {
        throw new Error('Bot operation returned an invalid HTTP status');
      }
      await transaction.botRequestIdempotency.update({
        where: { id: pending.id },
        data: {
          responseStatus: response.statusCode,
          responseBody: response.body,
          completedAt: new Date(),
        },
      });
      return { ...response, replayed: false };
    });
  }
}

function idempotencyScope(request: AuthenticatedBotRequest) {
  return {
    principalId: request.principalId,
    method: request.method,
    path: request.path,
    telegramUserId: request.telegramUserId,
    idempotencyKey: request.idempotencyKey,
  };
}

function idempotencyLockScope(request: AuthenticatedBotRequest): string {
  return JSON.stringify([
    'bot-idempotency-v1',
    request.principalId,
    request.method,
    request.path,
    request.telegramUserId,
    request.idempotencyKey,
  ]);
}
