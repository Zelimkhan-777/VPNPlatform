import { Controller, Get, Header, Inject, Param, Req } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { SubscriptionFeed } from '@vpn-platform/contracts';

import { SubscriptionFeedRateLimiterService } from './subscription-feed-rate-limiter.service';
import { SubscriptionFeedService } from './subscription-feed.service';

@ApiTags('subscription-feed')
@Controller('sub')
export class SubscriptionFeedController {
  constructor(
    @Inject(SubscriptionFeedService)
    private readonly feedService: SubscriptionFeedService,
    @Inject(SubscriptionFeedRateLimiterService)
    private readonly rateLimiter: SubscriptionFeedRateLimiterService,
  ) {}

  @Get(':token')
  @Header('content-type', 'text/plain; charset=utf-8')
  @Header('cache-control', 'no-store')
  @ApiOperation({
    summary: 'Получить subscription feed устройства',
    description:
      'Bearer token устройства проверяется сервером. Пока пул VPN-нод не подключён, успешный ответ содержит пустой список конфигураций.',
  })
  @ApiOkResponse({
    description: 'Текстовый subscription feed',
    content: { 'text/plain': { schema: { type: 'string', maxLength: 16384 } } },
  })
  @ApiUnauthorizedResponse({
    description: 'Неверный, отозванный или истёкший token',
  })
  @ApiTooManyRequestsResponse({ description: 'Too many requests' })
  @ApiParam({
    name: 'token',
    description: 'Opaque device subscription token',
    schema: { type: 'string', minLength: 43, maxLength: 43 },
  })
  async feed(
    @Param('token') token: string,
    @Req() request: { ip: string },
  ): Promise<SubscriptionFeed> {
    this.rateLimiter.assertAllowed(request.ip);
    return this.feedService.feed(token);
  }
}
