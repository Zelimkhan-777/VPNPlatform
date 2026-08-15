import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;
  private readonly namespace: string;

  constructor(@Inject(API_ENVIRONMENT) environment: ApiEnvironment) {
    this.namespace = environment.API_REDIS_KEY_NAMESPACE;
    this.client = new Redis(environment.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: environment.HEALTH_CHECK_TIMEOUT_MS,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    });

    // Ioredis emits connection errors as events. Observe them without logging
    // connection details or credentials; readiness exposes only up/down state.
    this.client.on('error', () => undefined);
  }

  async ping(): Promise<void> {
    await this.ensureConnected();

    const response = await this.client.ping();
    if (response !== 'PONG') {
      throw new Error('Redis returned an unexpected PING response');
    }
  }

  async incrementWithExpiry(key: string, windowMs: number): Promise<number> {
    await this.ensureConnected();

    const result = await this.client.eval(
      [
        'local attempts = redis.call("INCR", KEYS[1])',
        'if attempts == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end',
        'return attempts',
      ].join('\n'),
      1,
      this.keyFor(key),
      windowMs,
    );
    if (typeof result !== 'number') {
      throw new Error('Redis returned an unexpected rate limit result');
    }

    return result;
  }

  async delete(key: string): Promise<void> {
    await this.ensureConnected();
    await this.client.del(this.keyFor(key));
  }

  keyFor(key: string): string {
    return `${this.namespace}:${key}`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.status === 'wait') {
      await this.client.connect();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status === 'wait' || this.client.status === 'end') {
      this.client.disconnect();
      return;
    }

    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
