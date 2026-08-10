import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  localSubscriptionFeedSchema,
  localSubscriptionFixture,
  type LocalSubscriptionFeed,
} from '@vpn-platform/contracts';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';

@Injectable()
export class SubscriptionPrototypeService {
  constructor(
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  feed(token: string): LocalSubscriptionFeed {
    if (!this.environment.LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED) {
      throw new NotFoundException();
    }

    const expectedToken = this.environment.LOCAL_SUBSCRIPTION_PROTOTYPE_TOKEN;
    if (!expectedToken || token !== expectedToken) {
      throw new UnauthorizedException();
    }

    return localSubscriptionFeedSchema.parse(localSubscriptionFixture);
  }
}
