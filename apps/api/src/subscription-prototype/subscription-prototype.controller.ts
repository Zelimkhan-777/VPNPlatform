import { Controller, Get, Header, Inject, Param } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SubscriptionPrototypeService } from './subscription-prototype.service';

@ApiTags('subscription-prototype')
@Controller('prototype/subscription')
export class SubscriptionPrototypeController {
  constructor(
    @Inject(SubscriptionPrototypeService)
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
  @Header('content-type', 'text/plain; charset=utf-8')
  feed(@Param('token') token: string): string {
    return this.subscriptionPrototypeService.feed(token);
  }
}
