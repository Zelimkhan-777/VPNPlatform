import { createHmac, randomBytes } from 'node:crypto';

import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, type UserRole } from '@prisma/client';
import {
  authenticatedSessionSchema,
  confirmedTelegramLoginSchema,
  pendingTelegramLoginSchema,
  type AuthenticatedSession,
  type ConfirmedTelegramLogin,
  type PendingTelegramLogin,
} from '@vpn-platform/contracts';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { AuthIssuerRateLimiterService } from './auth-issuer-rate-limiter.service';
import type { AuthenticatedBotRequest } from './bot-request-authentication.service';
import { BotRequestExecutionService } from './bot-request-execution.service';
import {
  TelegramInitDataValidationError,
  verifyTelegramInitData,
} from './telegram-init-data';

const PENDING_LOGIN_TTL_MS = 120_000;
const PENDING_MATERIAL_GENERATION_ATTEMPTS = 5;
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface BegunPendingLogin {
  pending: PendingTelegramLogin;
  secret: string;
}

export interface CompletedPendingLogin {
  session: AuthenticatedSession;
  secret: string;
}

interface LockedPendingLogin {
  id: string;
  challengeId: string;
  userId: string;
  telegramUserId: string;
  expiresAt: Date;
  status: 'AWAITING_BOT_CONFIRM' | 'BOT_CONFIRMED' | 'CONSUMED';
  challenge: {
    consumedAt: Date | null;
    expiresAt: Date;
  };
}

@Injectable()
export class PendingLoginService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
    @Inject(AuthIssuerRateLimiterService)
    private readonly rateLimiter: AuthIssuerRateLimiterService,
    @Inject(BotRequestExecutionService)
    private readonly botExecution: BotRequestExecutionService,
  ) {}

  async begin(
    initData: string,
    processNow = new Date(),
  ): Promise<BegunPendingLogin> {
    const botToken = this.environment.TELEGRAM_WEB_APP_BOT_TOKEN;
    const pepper = this.environment.AUTH_SESSION_PEPPER;
    if (!botToken || !pepper) {
      throw new ServiceUnavailableException('Telegram login is unavailable');
    }

    const proof = verifyTelegramInitData(
      initData,
      botToken,
      this.environment.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
      processNow,
    );
    await this.rateLimiter.assertInitialAllowed(proof.id);

    for (
      let attempt = 0;
      attempt < PENDING_MATERIAL_GENERATION_ATTEMPTS;
      attempt += 1
    ) {
      const secret = randomBytes(32).toString('base64url');
      const confirmationCode = createCrockfordCode();
      try {
        const pending = await this.prisma.$transaction(async (transaction) => {
          await transaction.$queryRaw`
        SELECT "id"
        FROM "AuthChallenge"
        WHERE "launchId" = ${proof.startParam}
        FOR UPDATE
      `;
          const challenge = await transaction.authChallenge.findUnique({
            where: { launchId: proof.startParam },
            select: {
              id: true,
              userId: true,
              expiresAt: true,
              consumedAt: true,
              user: { select: { telegramUserId: true } },
            },
          });
          const databaseClock = await transaction.$queryRaw<{ now: Date }[]>`
        SELECT clock_timestamp() AS "now"
      `;
          const now = databaseClock[0]?.now;
          if (!challenge || !now) throw new TelegramInitDataValidationError();

          const authoritativeProof = verifyTelegramInitData(
            initData,
            botToken,
            this.environment.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
            now,
          );
          if (
            authoritativeProof.id !== proof.id ||
            authoritativeProof.replayKey !== proof.replayKey ||
            authoritativeProof.startParam !== proof.startParam ||
            !challenge.userId ||
            challenge.user?.telegramUserId !== authoritativeProof.id ||
            challenge.consumedAt !== null ||
            challenge.expiresAt <= now
          ) {
            throw new TelegramInitDataValidationError();
          }

          const expiresAt = new Date(
            Math.min(
              challenge.expiresAt.getTime(),
              now.getTime() + PENDING_LOGIN_TTL_MS,
            ),
          );
          await transaction.pendingLogin.create({
            data: {
              challengeId: challenge.id,
              userId: challenge.userId,
              telegramUserId: authoritativeProof.id,
              pendingTokenHash: hashPendingSecret(secret, pepper),
              confirmationCodeHash: hashConfirmationCode(
                authoritativeProof.id,
                confirmationCode,
                pepper,
              ),
              createdAt: now,
              expiresAt,
            },
          });
          return pendingTelegramLoginSchema.parse({
            confirmationCode,
            expiresAt: expiresAt.toISOString(),
          });
        });
        return { pending, secret };
      } catch (error) {
        if (!isUniqueConstraintViolation(error)) throw error;
      }
    }

    throw new ServiceUnavailableException('Telegram login is unavailable');
  }

  async confirm(
    request: AuthenticatedBotRequest,
    confirmationCode: string,
  ): Promise<ConfirmedTelegramLogin> {
    const pepper = this.environment.AUTH_SESSION_PEPPER;
    if (!pepper) {
      throw new ServiceUnavailableException('Telegram login is unavailable');
    }

    const result = await this.botExecution.execute(
      request,
      async (transaction) => {
        await this.rateLimiter.assertConfirmationAllowed(
          request.principalId,
          request.telegramUserId,
        );
        const confirmationCodeHash = hashConfirmationCode(
          request.telegramUserId,
          confirmationCode,
          pepper,
        );
        const lockedCandidates = await transaction.$queryRaw<{ id: string }[]>`
        SELECT pending."id"
        FROM "PendingLogin" AS pending
        INNER JOIN "AuthChallenge" AS challenge
          ON challenge."id" = pending."challengeId"
        WHERE pending."telegramUserId" = ${request.telegramUserId}
          AND pending."confirmationCodeHash" = ${confirmationCodeHash}
          AND pending."status" = 'AWAITING_BOT_CONFIRM'
        ORDER BY pending."createdAt" DESC
        LIMIT 2
          FOR UPDATE OF pending, challenge
        `;
        const candidates = await transaction.pendingLogin.findMany({
          where: {
            telegramUserId: request.telegramUserId,
            confirmationCodeHash,
            status: 'AWAITING_BOT_CONFIRM',
          },
          orderBy: { createdAt: 'desc' },
          take: 2,
          select: {
            id: true,
            challengeId: true,
            userId: true,
            telegramUserId: true,
            expiresAt: true,
            status: true,
            challenge: { select: { consumedAt: true, expiresAt: true } },
          },
        });
        const databaseClock = await transaction.$queryRaw<{ now: Date }[]>`
        SELECT clock_timestamp() AS "now"
      `;
        const now = databaseClock[0]?.now;
        const pending = candidates[0] as LockedPendingLogin | undefined;
        if (
          lockedCandidates.length !== 1 ||
          candidates.length !== 1 ||
          !pending ||
          pending.id !== lockedCandidates[0]?.id ||
          !now ||
          pending.userId.length === 0 ||
          pending.telegramUserId !== request.telegramUserId ||
          pending.expiresAt <= now ||
          pending.challenge.expiresAt <= now ||
          pending.challenge.consumedAt !== null
        ) {
          throw invalidLogin();
        }
        await transaction.pendingLogin.update({
          where: { id: pending.id },
          data: { status: 'BOT_CONFIRMED', confirmedAt: now },
        });
        return {
          statusCode: 200,
          body: { status: 'BOT_CONFIRMED' } as const,
        };
      },
    );

    return confirmedTelegramLoginSchema.parse(result.body);
  }

  async complete(secret: string): Promise<CompletedPendingLogin> {
    const pepper = this.environment.AUTH_SESSION_PEPPER;
    if (!pepper || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
      throw invalidLogin();
    }

    const sessionSecret = randomBytes(32).toString('base64url');
    const completed = await this.prisma.$transaction(async (transaction) => {
      const pendingTokenHash = hashPendingSecret(secret, pepper);
      const lockedPending = await transaction.$queryRaw<{ id: string }[]>`
        SELECT pending."id"
        FROM "PendingLogin" AS pending
        INNER JOIN "AuthChallenge" AS challenge
          ON challenge."id" = pending."challengeId"
        WHERE pending."pendingTokenHash" = ${pendingTokenHash}
        FOR UPDATE OF pending, challenge
      `;
      const pending = (await transaction.pendingLogin.findUnique({
        where: { pendingTokenHash },
        select: {
          id: true,
          challengeId: true,
          userId: true,
          telegramUserId: true,
          expiresAt: true,
          status: true,
          challenge: { select: { consumedAt: true, expiresAt: true } },
        },
      })) as LockedPendingLogin | null;
      const databaseClock = await transaction.$queryRaw<{ now: Date }[]>`
        SELECT clock_timestamp() AS "now"
      `;
      const now = databaseClock[0]?.now;
      if (
        lockedPending.length !== 1 ||
        !pending ||
        pending.id !== lockedPending[0]?.id ||
        !now ||
        pending.status !== 'BOT_CONFIRMED' ||
        pending.expiresAt <= now ||
        pending.challenge.expiresAt <= now ||
        pending.challenge.consumedAt !== null
      ) {
        throw invalidLogin();
      }
      const user = await transaction.user.findFirst({
        where: {
          id: pending.userId,
          telegramUserId: pending.telegramUserId,
        },
        select: { id: true, role: true },
      });
      if (!user) throw invalidLogin();

      const expiresAt = new Date(
        now.getTime() + this.environment.AUTH_SESSION_TTL_SECONDS * 1_000,
      );
      const session = await transaction.userSession.create({
        data: {
          userId: user.id,
          tokenHash: createHmac('sha256', pepper)
            .update(sessionSecret)
            .digest('hex'),
          telegramReplayHash: createHmac('sha256', pepper)
            .update(`telegram-pending-replay-v1\u0000${pending.challengeId}`)
            .digest('hex'),
          expiresAt,
        },
        select: { id: true },
      });
      await transaction.pendingLogin.update({
        where: { id: pending.id },
        data: { status: 'CONSUMED', consumedAt: now },
      });
      await transaction.authChallenge.update({
        where: { id: pending.challengeId },
        data: {
          telegramReplayHash: createHmac('sha256', pepper)
            .update(`telegram-pending-replay-v1\u0000${pending.challengeId}`)
            .digest('hex'),
          sessionId: session.id,
          consumedAt: now,
        },
      });
      return authenticatedSessionSchema.parse({
        user: serializeUser(user),
        expiresAt: expiresAt.toISOString(),
      });
    });

    return { session: completed, secret: sessionSecret };
  }
}

function invalidLogin(): UnauthorizedException {
  return new UnauthorizedException('Telegram login is invalid');
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function serializeUser(user: { id: string; role: UserRole }) {
  return { id: user.id, role: user.role };
}

export function hashPendingSecret(secret: string, pepper: string): string {
  return createHmac('sha256', pepper)
    .update(`telegram-pending-token-v1\u0000${secret}`)
    .digest('hex');
}

export function hashConfirmationCode(
  telegramUserId: string,
  code: string,
  pepper: string,
): string {
  return createHmac('sha256', pepper)
    .update(`telegram-confirmation-code-v1\u0000${telegramUserId}\u0000${code}`)
    .digest('hex');
}

function createCrockfordCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (byte) => CROCKFORD_ALPHABET[byte & 31]).join('');
}
