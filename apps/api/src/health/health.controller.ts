import { Controller, Get, Inject } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type {
  LivenessResponse,
  ReadinessResponse,
} from '@vpn-platform/contracts';

import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(HealthService) private readonly healthService: HealthService,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Проверить, что процесс API работает' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['status'],
      properties: { status: { type: 'string', enum: ['ok'] } },
    },
  })
  live(): LivenessResponse {
    return this.healthService.live();
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Проверить доступность зависимостей API',
    description:
      'Выполняет PostgreSQL SELECT 1 через Prisma и Redis PING с ограниченным timeout.',
  })
  @ApiOkResponse({
    description: 'PostgreSQL и Redis доступны',
    schema: readinessSchema(['ready']),
  })
  @ApiServiceUnavailableResponse({
    description: 'Одна из зависимостей недоступна',
    schema: readinessSchema(['unavailable']),
  })
  ready(): Promise<ReadinessResponse> {
    return this.healthService.ready();
  }
}

function readinessSchema(status: ['ready'] | ['unavailable']) {
  return {
    type: 'object',
    required: ['status', 'dependencies'],
    properties: {
      status: { type: 'string', enum: status },
      dependencies: {
        type: 'object',
        required: ['postgres', 'redis'],
        properties: {
          postgres: { type: 'string', enum: ['up', 'down'] },
          redis: { type: 'string', enum: ['up', 'down'] },
        },
      },
    },
  };
}
