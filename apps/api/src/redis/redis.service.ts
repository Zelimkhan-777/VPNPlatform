import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(@Inject(API_ENVIRONMENT) environment: ApiEnvironment) {
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
    if (this.client.status === 'wait') {
      await this.client.connect();
    }

    const response = await this.client.ping();
    if (response !== 'PONG') {
      throw new Error('Redis returned an unexpected PING response');
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
