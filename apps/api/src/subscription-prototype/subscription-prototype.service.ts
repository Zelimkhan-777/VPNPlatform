import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
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
    if (!expectedToken || !this.tokensMatch(token, expectedToken)) {
      throw new UnauthorizedException();
    }

    return localSubscriptionFeedSchema.parse(localSubscriptionFixture);
  }

  private tokensMatch(providedToken: string, expectedToken: string): boolean {
    const provided = Buffer.from(providedToken);
    const expected = Buffer.from(expectedToken);

    return (
      provided.length === expected.length && timingSafeEqual(provided, expected)
    );
  }
}
