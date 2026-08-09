import { Injectable } from '@nestjs/common';
import { Socket } from 'node:net';
import { z } from 'zod';

import type { HealthDependencyChecker } from './health.types';

const healthEnvironmentSchema = z.object({
  POSTGRES_HOST: z.string().min(1).default('127.0.0.1'),
  POSTGRES_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  REDIS_HOST: z.string().min(1).default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65_535).default(6379),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(5_000)
    .default(750),
});

@Injectable()
export class TcpDependencyChecker implements HealthDependencyChecker {
  private readonly environment = healthEnvironmentSchema.parse(process.env);

  async check(): ReturnType<HealthDependencyChecker['check']> {
    const [postgres, redis] = await Promise.all([
      this.canConnect(
        this.environment.POSTGRES_HOST,
        this.environment.POSTGRES_PORT,
      ),
      this.canConnect(this.environment.REDIS_HOST, this.environment.REDIS_PORT),
    ]);

    return {
      postgres: postgres ? 'up' : 'down',
      redis: redis ? 'up' : 'down',
    };
  }

  private canConnect(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new Socket();
      let settled = false;

      const finish = (reachable: boolean): void => {
        if (settled) {
          return;
        }

        settled = true;
        socket.destroy();
        resolve(reachable);
      };

      socket.setTimeout(this.environment.HEALTH_CHECK_TIMEOUT_MS);
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
      socket.connect(port, host);
    });
  }
}
