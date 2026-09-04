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
export class TrialActivationRateLimiterService {
  constructor(
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  async assertAllowed(
    principalId: string,
    telegramUserId: string,
  ): Promise<void> {
    try {
      const attempts = await this.redis.incrementWithExpiry(
        `trial-activation:rate-limit:${principalId}:${telegramUserId}`,
        this.environment.TRIAL_ACTIVATION_RATE_LIMIT_WINDOW_MS,
      );
      if (attempts > this.environment.TRIAL_ACTIVATION_RATE_LIMIT_MAX) {
        throw new HttpException(
          'Too many trial activation requests',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Trial activation is unavailable');
    }
  }
}
