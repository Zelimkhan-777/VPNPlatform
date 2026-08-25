import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  telegramLoginRequestSchema,
  type AuthenticatedSession,
} from '@vpn-platform/contracts';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import {
  AuthSessionService,
  TelegramInitDataValidationError,
} from './auth-session.service';
import { TrustedOriginGuard } from './trusted-origin.guard';

const sessionCookieName = 'vpn_platform_session';
const prelaunchCookieName = 'vpn_platform_prelaunch';

interface CookieReply {
  header(name: string, value: string): unknown;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthSessionService) private readonly sessions: AuthSessionService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  @Post('telegram')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Создать серверную сессию по подписанным Telegram Web App данным',
    description:
      'Секрет сессии передаётся только в HttpOnly cookie. Telegram initData и секрет сессии не возвращаются в JSON.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['initData'],
      properties: {
        initData: { type: 'string', minLength: 1, maxLength: 8192 },
      },
    },
  })
  @ApiOkResponse({ schema: authenticatedSessionOpenApiSchema() })
  @ApiBadRequestResponse({ description: 'Некорректное тело запроса' })
  @ApiUnauthorizedResponse({
    description: 'Telegram login не прошёл проверку',
  })
  @ApiNotFoundResponse({ description: 'Вход через Telegram ещё не настроен' })
  async signIn(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: CookieReply,
    @Headers('cookie') cookieHeader: string | undefined = undefined,
  ): Promise<AuthenticatedSession> {
    const request = telegramLoginRequestSchema.safeParse(body);
    if (!request.success) {
      throw new BadRequestException('Telegram login request is invalid');
    }

    let issued;
    try {
      issued = await this.sessions.signInWithTelegram(
        request.data.initData,
        readCookie(cookieHeader, prelaunchCookieName),
      );
    } catch (error) {
      if (error instanceof TelegramInitDataValidationError) {
        throw new UnauthorizedException('Telegram login is invalid');
      }
      throw error;
    }
    if (!issued) {
      if (
        !this.environment.TELEGRAM_WEB_APP_BOT_TOKEN ||
        !this.environment.AUTH_SESSION_PEPPER
      ) {
        throw new NotFoundException('Telegram login is unavailable');
      }
      throw new UnauthorizedException('Telegram login is invalid');
    }

    reply.header('Cache-Control', 'no-store');
    reply.header(
      'Set-Cookie',
      serializeSessionCookie(
        issued.secret,
        this.environment.AUTH_SESSION_TTL_SECONDS,
        this.environment.NODE_ENV === 'production',
      ),
    );
    return issued.session;
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(TrustedOriginGuard)
  @ApiHeader({
    name: 'origin',
    required: true,
    description: 'Trusted cabinet origin',
  })
  @ApiNoContentResponse({ description: 'Сессия отозвана или уже отсутствует' })
  @ApiForbiddenResponse({ description: 'Недоверенный Origin кабинета' })
  async logout(
    @Headers('cookie') cookieHeader: string | undefined,
    @Res({ passthrough: true }) reply: CookieReply,
  ): Promise<void> {
    await this.sessions.revokeFromCookie(cookieHeader);
    reply.header('Cache-Control', 'no-store');
    reply.header(
      'Set-Cookie',
      serializeCookie(
        sessionCookieName,
        '',
        0,
        this.environment.NODE_ENV === 'production',
      ),
    );
  }

  @Get('me')
  @ApiOperation({ summary: 'Получить текущую серверную сессию' })
  @ApiOkResponse({ schema: authenticatedSessionOpenApiSchema() })
  @ApiUnauthorizedResponse({
    description: 'Сессия отсутствует, истекла или отозвана',
  })
  async current(
    @Headers('cookie') cookieHeader: string | undefined,
  ): Promise<AuthenticatedSession> {
    const session = await this.sessions.currentSessionFromCookie(cookieHeader);
    if (!session) {
      throw new UnauthorizedException('Session is invalid');
    }
    return session;
  }
}

function serializeSessionCookie(
  secret: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return serializeCookie(sessionCookieName, secret, maxAgeSeconds, secure);
}

function serializeCookie(
  name: string,
  secret: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return [
    `${name}=${secret}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function readCookie(cookieHeader: string | undefined, name: string): string {
  if (!cookieHeader) return '';
  return (
    cookieHeader
      .split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ''
  );
}

function authenticatedSessionOpenApiSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['user', 'expiresAt'],
    properties: {
      user: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'role'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          role: { type: 'string', enum: ['CUSTOMER', 'ADMIN'] },
        },
      },
      expiresAt: { type: 'string', format: 'date-time' },
    },
  };
}
