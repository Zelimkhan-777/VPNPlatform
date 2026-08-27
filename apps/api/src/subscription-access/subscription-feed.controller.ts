import { Controller, Get, Header, Inject, Param, Req } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiServiceUnavailableResponse,
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
      'Bearer token устройства проверяется сервером. Renderer выдаёт только подтверждённые VLESS/TCP/TLS/HAPP маршруты; отсутствие готового маршрута означает временную инфраструктурную недоступность.',
  })
  @ApiOkResponse({
    description: 'Текстовый subscription feed',
    content: { 'text/plain': { schema: { type: 'string', maxLength: 16384 } } },
  })
  @ApiUnauthorizedResponse({
    description: 'Неверный, отозванный или истёкший token',
  })
  @ApiServiceUnavailableResponse({
    description: 'Entitlement действует, но готовый VPN-маршрут недоступен',
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
    await this.rateLimiter.assertAllowed(request.ip);
    return this.feedService.feed(token);
  }
}
