import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  BOT_AUTH_HEADER_NAMES,
  botRequestMethodSchema,
  botRequestPathSchema,
  botSignedRequestHeadersSchema,
  botTelegramIdentitySchema,
} from '@vpn-platform/contracts';

import {
  type AuthenticatedBotRequest,
  BotRequestAuthenticationService,
} from './bot-request-authentication.service';

const invalidBotRequestMessage = 'Bot request is invalid';

interface RequestWithRawBody {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  method: string;
  raw: { url?: string };
  rawBody?: Buffer;
  authenticatedBot?: AuthenticatedBotRequest;
}

@Injectable()
export class BotRequestAuthenticationGuard implements CanActivate {
  constructor(
    @Inject(BotRequestAuthenticationService)
    private readonly authentication: BotRequestAuthenticationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithRawBody>();
    const headers = botSignedRequestHeadersSchema.safeParse({
      credentialId: request.headers[BOT_AUTH_HEADER_NAMES.credentialId],
      idempotencyKey: request.headers[BOT_AUTH_HEADER_NAMES.idempotencyKey],
      nonce: request.headers[BOT_AUTH_HEADER_NAMES.nonce],
      signature: request.headers[BOT_AUTH_HEADER_NAMES.signature],
      timestamp: request.headers[BOT_AUTH_HEADER_NAMES.timestamp],
    });
    const identity = botTelegramIdentitySchema.safeParse(request.body);
    const method = botRequestMethodSchema.safeParse(request.method);
    const path = botRequestPathSchema.safeParse(request.raw.url);
    if (
      !headers.success ||
      !identity.success ||
      !method.success ||
      !path.success ||
      !Buffer.isBuffer(request.rawBody)
    ) {
      throw new UnauthorizedException(invalidBotRequestMessage);
    }

    const authenticated = await this.authentication.authenticate({
      ...headers.data,
      method: method.data,
      path: path.data,
      rawBody: request.rawBody,
      telegramUserId: identity.data.telegramUserId,
    });
    if (!authenticated) {
      throw new UnauthorizedException(invalidBotRequestMessage);
    }
    request.authenticatedBot = authenticated;
    return true;
  }
}
