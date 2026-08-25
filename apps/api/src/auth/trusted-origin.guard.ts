import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';

interface RequestWithHeaders {
  headers: { origin?: string | string[] };
}

@Injectable()
export class TrustedOriginGuard implements CanActivate {
  constructor(
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const origin = context.switchToHttp().getRequest<RequestWithHeaders>()
      .headers.origin;
    if (
      !this.environment.CABINET_ORIGIN ||
      origin !== this.environment.CABINET_ORIGIN
    ) {
      throw new ForbiddenException('Cabinet origin is invalid');
    }
    return true;
  }
}
