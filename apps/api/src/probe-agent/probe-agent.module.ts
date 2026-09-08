import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { ProbeAgentController } from './probe-agent.controller';
import { ProbeIngestionRateLimiterService } from './probe-ingestion-rate-limiter.service';
import { ProbeIngestionService } from './probe-ingestion.service';
import { ProbeSourceCredentialService } from './probe-source-credential.service';

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [ProbeAgentController],
  providers: [
    ProbeSourceCredentialService,
    ProbeIngestionRateLimiterService,
    ProbeIngestionService,
  ],
  exports: [ProbeSourceCredentialService],
})
export class ProbeAgentModule {}
