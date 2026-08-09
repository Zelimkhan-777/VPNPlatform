import { Inject, Injectable } from '@nestjs/common';
import type { DependencyStatus } from '@vpn-platform/contracts';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { HealthDependencyChecker } from './health.types';

@Injectable()
export class InfrastructureDependencyChecker implements HealthDependencyChecker {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(API_ENVIRONMENT)
    private readonly environment: ApiEnvironment,
  ) {}

  async check(): ReturnType<HealthDependencyChecker['check']> {
    const [postgres, redis] = await Promise.all([
      this.dependencyStatus(() => this.prisma.ping()),
      this.dependencyStatus(() => this.redis.ping()),
    ]);

    return { postgres, redis };
  }

  private async dependencyStatus(
    operation: () => Promise<void>,
  ): Promise<DependencyStatus> {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Infrastructure health check timed out')),
            this.environment.HEALTH_CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      return 'up';
    } catch {
      return 'down';
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}
