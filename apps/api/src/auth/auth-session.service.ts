import { createHmac, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type {
  AuthenticatedSession,
  AuthenticatedUser,
} from '@vpn-platform/contracts';
import type { UserRole } from '@prisma/client';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import {
  TelegramInitDataValidationError,
  verifyTelegramInitData,
} from './telegram-init-data';

export { TelegramInitDataValidationError };

export interface IssuedSession {
  session: AuthenticatedSession;
  secret: string;
}

@Injectable()
export class AuthSessionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  async createChallenge(now = new Date()): Promise<string | null> {
    const pepper = this.environment.AUTH_SESSION_PEPPER;
    if (!pepper || !this.environment.TELEGRAM_WEB_APP_BOT_TOKEN) return null;
    const secret = randomBytes(32).toString('base64url');
    await this.prisma.authChallenge.create({
      data: {
        tokenHash: this.hashSecret(secret, pepper),
        expiresAt: new Date(
          now.getTime() +
            this.environment.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS * 1_000,
        ),
      },
    });
    return secret;
  }

  async signInWithTelegram(
    initData: string,
    challengeSecret: string | Date,
    now = new Date(),
  ): Promise<IssuedSession | null> {
    if (challengeSecret instanceof Date) {
      now = challengeSecret;
      challengeSecret = '';
    }
    const botToken = this.environment.TELEGRAM_WEB_APP_BOT_TOKEN;
    const pepper = this.environment.AUTH_SESSION_PEPPER;
    if (!botToken || !pepper) {
      return null;
    }

    const telegramUser = verifyTelegramInitData(
      initData,
      botToken,
      this.environment.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
      now,
    );
    if (!isSessionSecret(challengeSecret)) return null;
    const secret = this.deriveTelegramSessionSecret(
      challengeSecret,
      telegramUser.replayKey,
      pepper,
    );
    const telegramReplayHash = this.hashTelegramReplayKey(
      telegramUser.replayKey,
      pepper,
    );
    const expiresAt = new Date(
      now.getTime() + this.environment.AUTH_SESSION_TTL_SECONDS * 1_000,
    );
    const tokenHash = this.hashSecret(secret, pepper);

    const session = await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT "id" FROM "AuthChallenge"
        WHERE "tokenHash" = ${this.hashSecret(challengeSecret, pepper)}
        FOR UPDATE
      `;
      const challenge = await transaction.authChallenge.findUnique({
        where: { tokenHash: this.hashSecret(challengeSecret, pepper) },
        select: {
          id: true,
          expiresAt: true,
          telegramReplayHash: true,
          sessionId: true,
        },
      });
      if (!challenge || challenge.expiresAt <= now) return null;
      if (
        challenge.telegramReplayHash &&
        challenge.telegramReplayHash !== telegramReplayHash
      )
        return null;
      if (challenge.sessionId) {
        const existing = await transaction.userSession.findUnique({
          where: { id: challenge.sessionId },
          select: {
            expiresAt: true,
            user: { select: { id: true, role: true } },
          },
        });
        return existing
          ? {
              user: serializeUser(existing.user),
              expiresAt: existing.expiresAt.toISOString(),
            }
          : null;
      }
      const replayed = await transaction.userSession.findUnique({
        where: { telegramReplayHash },
        select: { id: true },
      });
      if (replayed) return null;
      const user = await transaction.user.upsert({
        where: { telegramUserId: telegramUser.id },
        create: { telegramUserId: telegramUser.id },
        update: {},
        select: { id: true, role: true },
      });
      const createdSession = await transaction.userSession.create({
        data: {
          userId: user.id,
          tokenHash,
          telegramReplayHash,
          expiresAt,
        },
        select: { id: true, expiresAt: true },
      });
      await transaction.authChallenge.update({
        where: { id: challenge.id },
        data: {
          telegramReplayHash,
          sessionId: createdSession.id,
          userId: user.id,
          consumedAt: now,
        },
      });

      return {
        user: serializeUser(user),
        expiresAt: createdSession.expiresAt.toISOString(),
      };
    });

    return session ? { session, secret } : null;
  }

  async currentSession(
    secret: string,
    now = new Date(),
  ): Promise<AuthenticatedSession | null> {
    const pepper = this.environment.AUTH_SESSION_PEPPER;
    if (!pepper || !isSessionSecret(secret)) {
      return null;
    }

    const session = await this.prisma.userSession.findFirst({
      where: {
        tokenHash: this.hashSecret(secret, pepper),
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: {
        expiresAt: true,
        user: { select: { id: true, role: true } },
      },
    });

    if (!session) {
      return null;
    }

    return {
      user: serializeUser(session.user),
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  currentSessionFromCookie(
    cookieHeader: string | undefined,
  ): Promise<AuthenticatedSession | null> {
    return this.currentSession(
      readCookie(cookieHeader, 'vpn_platform_session'),
    );
  }

  async revokeFromCookie(
    cookieHeader: string | undefined,
    now = new Date(),
  ): Promise<void> {
    const pepper = this.environment.AUTH_SESSION_PEPPER;
    const secret = readCookie(cookieHeader, 'vpn_platform_session');
    if (!pepper || !isSessionSecret(secret)) return;
    await this.prisma.userSession.updateMany({
      where: { tokenHash: this.hashSecret(secret, pepper), revokedAt: null },
      data: { revokedAt: now },
    });
  }

  private hashSecret(secret: string, pepper: string): string {
    return createHmac('sha256', pepper).update(secret).digest('hex');
  }

  private hashTelegramReplayKey(replayKey: string, pepper: string): string {
    return createHmac('sha256', pepper)
      .update(`telegram-init-data-replay-v1\u0000${replayKey}`)
      .digest('hex');
  }

  private deriveTelegramSessionSecret(
    challengeSecret: string,
    replayKey: string,
    pepper: string,
  ): string {
    return createHmac('sha256', pepper)
      .update(`telegram-session-v2\u0000${challengeSecret}\u0000${replayKey}`)
      .digest('base64url');
  }
}

function readCookie(cookieHeader: string | undefined, name: string): string {
  if (!cookieHeader) {
    return '';
  }

  for (const item of cookieHeader.split(';')) {
    const [key, ...value] = item.trim().split('=');
    if (key === name) {
      return value.join('=');
    }
  }
  return '';
}

function isSessionSecret(secret: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(secret);
}

function serializeUser(user: {
  id: string;
  role: UserRole;
}): AuthenticatedUser {
  return { id: user.id, role: user.role };
}
