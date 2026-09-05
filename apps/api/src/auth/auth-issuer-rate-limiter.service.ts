import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class AuthIssuerRateLimiterService {
  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  async assertInitialAllowed(telegramUserId: string): Promise<void> {
    return this.assertAllowed(`auth-initial:rate-limit:${telegramUserId}`);
  }

  async assertConfirmationAllowed(
    principalId: string,
    telegramUserId: string,
  ): Promise<void> {
    return this.assertAllowed(
      `auth-confirm:rate-limit:${principalId}:${telegramUserId}`,
    );
  }

  async assertCompletionAllowed(clientIdentity: string): Promise<void> {
    return this.assertAllowed(`auth-complete:rate-limit:${clientIdentity}`);
  }

  private async assertAllowed(key: string): Promise<void> {
    try {
      const attempts = await this.redis.incrementWithExpiry(
        key,
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
      throw new ServiceUnavailableException('Telegram login is unavailable');
    }
  }
}
