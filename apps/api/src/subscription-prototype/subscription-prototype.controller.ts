import { Controller, Get, Param, Res } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { SubscriptionPrototypeService } from './subscription-prototype.service';

@ApiTags('subscription-prototype')
@Controller('prototype/subscription')
export class SubscriptionPrototypeController {
  constructor(
    private readonly subscriptionPrototypeService: SubscriptionPrototypeService,
  ) {}

  @Get(':token')
  @ApiOperation({
    summary: 'Получить локальный fixture subscription-ответа',
    description:
      'Только для закрытого локального прототипа; endpoint выключен по умолчанию и не содержит VLESS-конфигураций.',
  })
  @ApiOkResponse({
    description: 'Текстовый fixture subscription-ответа',
    content: {
      'text/plain': {
        schema: {
          type: 'string',
          example: '# VPNPlatform local subscription prototype\\n',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Неверный или отсутствующий токен' })
  @ApiNotFoundResponse({ description: 'Локальный прототип выключен' })
  feed(
    @Param('token') token: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): string {
    reply.type('text/plain; charset=utf-8');
    return this.subscriptionPrototypeService.feed(token);
  }
}
