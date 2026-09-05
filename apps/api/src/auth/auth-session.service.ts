import { createHmac } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type {
  AuthenticatedSession,
  AuthenticatedUser,
} from '@vpn-platform/contracts';
import type { UserRole } from '@prisma/client';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class AuthSessionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

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
