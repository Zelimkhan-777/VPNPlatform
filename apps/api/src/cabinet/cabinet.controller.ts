import {
  Controller,
  Get,
  Headers,
  Inject,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CabinetOverview } from '@vpn-platform/contracts';

import { AuthSessionService } from '../auth/auth-session.service';
import { CabinetService } from './cabinet.service';

@ApiTags('cabinet')
@Controller('cabinet')
export class CabinetController {
  constructor(
    @Inject(AuthSessionService) private readonly sessions: AuthSessionService,
    @Inject(CabinetService) private readonly cabinet: CabinetService,
  ) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Получить безопасную сводку кабинета текущего пользователя',
    description:
      'Возвращает только данные владельца активной сессии; не содержит subscription URL, хешей или VPN-ключей.',
  })
  @ApiOkResponse({ schema: cabinetOverviewOpenApiSchema() })
  @ApiUnauthorizedResponse({
    description: 'Сессия отсутствует, истекла или отозвана',
  })
  async overview(
    @Headers('cookie') cookieHeader: string | undefined,
  ): Promise<CabinetOverview> {
    const session = await this.sessions.currentSessionFromCookie(cookieHeader);
    if (!session) {
      throw new UnauthorizedException('Session is invalid');
    }

    return this.cabinet.overview(session.user.id);
  }
}

function cabinetOverviewOpenApiSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['subscription', 'devices'],
    properties: {
      subscription: {
        nullable: true,
        type: 'object',
        additionalProperties: false,
        required: [
          'status',
          'planName',
          'deviceLimit',
          'startsAt',
          'expiresAt',
        ],
        properties: {
          status: {
            type: 'string',
            enum: ['PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED'],
          },
          planName: { type: 'string', minLength: 1, maxLength: 128 },
          deviceLimit: { type: 'integer', minimum: 1 },
          startsAt: { type: 'string', format: 'date-time', nullable: true },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      devices: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'displayName', 'platform', 'status', 'createdAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            displayName: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
              nullable: true,
            },
            platform: {
              type: 'string',
              minLength: 1,
              maxLength: 32,
              nullable: true,
            },
            status: { type: 'string', enum: ['ACTIVE', 'REVOKED'] },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  };
}
