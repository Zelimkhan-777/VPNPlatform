import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { RedisService } from '../redis/redis.service';

const fingerprint = (value: string) =>
  createHash('sha256').update(value).digest('hex');

@Injectable()
export class ProbeIngestionRateLimiterService {
  constructor(
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  async assertIpAllowed(clientIp: string): Promise<void> {
    try {
      const attempts = await this.redis.incrementWithExpiry(
        `probe-ingestion:ip:${fingerprint(clientIp)}`,
        this.environment.PROBE_INGESTION_RATE_LIMIT_WINDOW_MS,
      );
      if (attempts > this.environment.PROBE_INGESTION_RATE_LIMIT_MAX) {
        throw new HttpException(
          'Too many probe submissions',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Probe ingestion is unavailable');
    }
  }

  async assertSourceAllowed(
    probeSourceId: string,
    scope: { kind: string; id: string },
  ): Promise<void> {
    try {
      const result = await this.redis.incrementWithCardinality(
        `probe-ingestion:source:${probeSourceId}:rate`,
        `probe-ingestion:source:${probeSourceId}:scopes`,
        fingerprint(`${scope.kind}:${scope.id}`),
        this.environment.PROBE_INGESTION_RATE_LIMIT_WINDOW_MS,
      );
      if (
        result.attempts > this.environment.PROBE_INGESTION_RATE_LIMIT_MAX ||
        result.cardinality >
          this.environment.PROBE_INGESTION_MAX_SCOPES_PER_WINDOW
      ) {
        throw new HttpException(
          'Too many probe submissions',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Probe ingestion is unavailable');
    }
  }
}
