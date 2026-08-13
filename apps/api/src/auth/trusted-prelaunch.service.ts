import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';

export interface TrustedPrelaunchContext {
  launchId: string;
  secret: string;
}

/**
 * Boundary for the future bot-mediated launch ceremony. There is intentionally
 * no HTTP controller for this service: browser code cannot mint login context.
 */
@Injectable()
export class TrustedPrelaunchService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  async issue(clientIdentity: string): Promise<TrustedPrelaunchContext> {
    try {
      const attempts = await this.redis.incrementWithExpiry(
        `auth-prelaunch:rate-limit:${clientIdentity}`,
        this.environment.AUTH_PRELAUNCH_RATE_LIMIT_WINDOW_MS,
      );
      if (attempts > this.environment.AUTH_PRELAUNCH_RATE_LIMIT_MAX) {
        throw new HttpException(
          'Too many requests',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Login preparation is unavailable');
    }

    const launchId = randomBytes(32).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    await this.prisma.$transaction(async (transaction) => {
      const databaseNow = await transaction.$queryRaw<{ now: Date }[]>`
        SELECT clock_timestamp() AS "now"
      `;
      const authoritativeNow = databaseNow[0]?.now;
      if (!authoritativeNow) {
        throw new ServiceUnavailableException(
          'Login preparation is unavailable',
        );
      }
      await transaction.authChallenge.create({
        data: {
          launchId,
          tokenHash: this.hashSecret(secret),
          createdAt: authoritativeNow,
          expiresAt: new Date(
            authoritativeNow.getTime() +
              this.environment.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS * 1_000,
          ),
        },
      });
    });
    await this.cleanupExpired();
    return { launchId, secret };
  }

  private async cleanupExpired(): Promise<void> {
    try {
      await this.prisma.$transaction(async (transaction) => {
        const databaseNow = await transaction.$queryRaw<{ now: Date }[]>`
          SELECT clock_timestamp() AS "now"
        `;
        const authoritativeNow = databaseNow[0]?.now;
        if (!authoritativeNow) return;
        const rows = await transaction.authChallenge.findMany({
          where: { expiresAt: { lt: authoritativeNow } },
          select: { id: true },
          orderBy: { expiresAt: 'asc' },
          take: this.environment.AUTH_CHALLENGE_CLEANUP_BATCH_SIZE,
        });
        if (rows.length) {
          await transaction.authChallenge.deleteMany({
            where: { id: { in: rows.map((row) => row.id) } },
          });
        }
      });
    } catch {
      // Best-effort bounded maintenance must never affect authentication.
    }
  }

  private hashSecret(secret: string): string {
    return createHmac('sha256', this.environment.AUTH_SESSION_PEPPER ?? '')
      .update(secret)
      .digest('hex');
  }
}
