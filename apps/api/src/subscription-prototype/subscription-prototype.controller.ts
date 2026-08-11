import { Controller, Get, Header, Inject, Param, Req } from '@nestjs/common';
import {
  ApiParam,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SubscriptionPrototypeRateLimiterService } from './subscription-prototype-rate-limiter.service';
import { SubscriptionPrototypeService } from './subscription-prototype.service';

@ApiTags('subscription-prototype')
@Controller('prototype/subscription')
export class SubscriptionPrototypeController {
  constructor(
    @Inject(SubscriptionPrototypeService)
    private readonly subscriptionPrototypeService: SubscriptionPrototypeService,
    @Inject(SubscriptionPrototypeRateLimiterService)
    private readonly rateLimiter: SubscriptionPrototypeRateLimiterService,
  ) {}

  @Get(':token')
  @ApiOperation({
    summary: 'Получить локальный fixture subscription-ответа',
    description:
      'Только для закрытого локального прототипа; endpoint выключен по умолчанию. Содержимое fixture задаётся только через некоммитимую локальную переменную окружения.',
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
  @Header('cache-control', 'no-store')
  @ApiTooManyRequestsResponse({ description: 'Too many requests' })
  @ApiParam({
    name: 'token',
    description: 'Opaque local-only prototype token',
    schema: { minLength: 32, type: 'string' },
  })
  feed(@Param('token') token: string, @Req() request: { ip: string }): string {
    this.subscriptionPrototypeService.assertEnabled();
    this.rateLimiter.assertAllowed(request.ip);

    return this.subscriptionPrototypeService.feed(token);
  }
}
