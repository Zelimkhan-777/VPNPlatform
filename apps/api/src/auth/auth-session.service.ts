import { createHmac } from 'node:crypto';

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

  async signInWithTelegram(
    initData: string,
    now = new Date(),
  ): Promise<IssuedSession | null> {
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
    const secret = this.deriveTelegramSessionSecret(
      telegramUser.id,
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
      const user = await transaction.user.upsert({
        where: { telegramUserId: telegramUser.id },
        create: { telegramUserId: telegramUser.id },
        update: {},
        select: { id: true, role: true },
      });
      const createdSession = await transaction.userSession.upsert({
        where: { telegramReplayHash },
        create: {
          userId: user.id,
          tokenHash,
          telegramReplayHash,
          expiresAt,
        },
        update: {},
        select: { expiresAt: true },
      });

      return {
        user: serializeUser(user),
        expiresAt: createdSession.expiresAt.toISOString(),
      };
    });

    return { session, secret };
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

  private hashSecret(secret: string, pepper: string): string {
    return createHmac('sha256', pepper).update(secret).digest('hex');
  }

  private hashTelegramReplayKey(replayKey: string, pepper: string): string {
    return createHmac('sha256', pepper)
      .update(`telegram-init-data-replay-v1\u0000${replayKey}`)
      .digest('hex');
  }

  private deriveTelegramSessionSecret(
    telegramUserId: string,
    replayKey: string,
    pepper: string,
  ): string {
    return createHmac('sha256', pepper)
      .update(`telegram-session-v1\u0000${telegramUserId}\u0000${replayKey}`)
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
