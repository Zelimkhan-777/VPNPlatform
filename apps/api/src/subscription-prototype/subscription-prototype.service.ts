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
import { z } from 'zod';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';

const localSubscriptionTokenSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

@Injectable()
export class SubscriptionPrototypeService {
  constructor(
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  assertEnabled(): void {
    if (!this.environment.LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED) {
      throw new NotFoundException();
    }
  }

  feed(token: string): LocalSubscriptionFeed {
    this.assertEnabled();

    const expectedToken = this.environment.LOCAL_SUBSCRIPTION_PROTOTYPE_TOKEN;
    if (
      !expectedToken ||
      !localSubscriptionTokenSchema.safeParse(token).success ||
      !this.tokensMatch(token, expectedToken)
    ) {
      throw new UnauthorizedException();
    }

    const content =
      this.environment.LOCAL_SUBSCRIPTION_PROTOTYPE_CONTENT ??
      localSubscriptionFixture;

    return localSubscriptionFeedSchema.parse(
      content.endsWith('\n') ? content : `${content}\n`,
    );
  }

  private tokensMatch(providedToken: string, expectedToken: string): boolean {
    const provided = Buffer.from(providedToken);
    const expected = Buffer.from(expectedToken);

    return (
      provided.length === expected.length && timingSafeEqual(provided, expected)
    );
  }
}
