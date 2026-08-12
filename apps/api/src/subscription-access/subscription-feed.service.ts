import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  subscriptionFeedSchema,
  type SubscriptionFeed,
} from '@vpn-platform/contracts';

import { SubscriptionAccessService } from './subscription-access.service';

@Injectable()
export class SubscriptionFeedService {
  constructor(
    @Inject(SubscriptionAccessService)
    private readonly access: SubscriptionAccessService,
  ) {}

  async feed(token: string): Promise<SubscriptionFeed> {
    const deviceId = await this.access.resolveDeviceId(token);
    if (!deviceId) {
      throw new UnauthorizedException('Subscription token is invalid');
    }

    // Node configuration delivery is intentionally not implemented yet.
    return subscriptionFeedSchema.parse('');
  }
}
