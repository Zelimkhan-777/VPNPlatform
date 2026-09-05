import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  BOT_AUTH_HEADER_NAMES,
  confirmedTelegramLoginSchema,
  confirmTelegramLoginRequestSchema,
  issueTelegramAuthChallengeRequestSchema,
  type ConfirmedTelegramLogin,
  type IssuedTelegramAuthChallenge,
} from '@vpn-platform/contracts';

import { BotAuthChallengeService } from './bot-auth-challenge.service';
import { BotRequestAuthenticationGuard } from './bot-request-authentication.guard';
import type { AuthenticatedBotRequest } from './bot-request-authentication.service';
import { PendingLoginService } from './pending-login.service';

interface AuthenticatedRequest {
  authenticatedBot?: AuthenticatedBotRequest;
}

@ApiTags('auth')
@Controller('auth/telegram')
export class BotAuthController {
  constructor(
    @Inject(BotAuthChallengeService)
    private readonly challenges: BotAuthChallengeService,
    @Inject(PendingLoginService)
    private readonly pendingLogins: PendingLoginService,
  ) {}

  @Post('challenge')
  @UseGuards(BotRequestAuthenticationGuard)
  @ApiOperation({
    summary: 'Выпустить одноразовый challenge входа для Telegram user',
    description:
      'Внутренний bot→API endpoint. Challenge выдаётся только пользователю с подтверждённым текущим или прошлым entitlement.',
  })
  @ApiHeader({ name: BOT_AUTH_HEADER_NAMES.credentialId, required: true })
  @ApiHeader({ name: BOT_AUTH_HEADER_NAMES.idempotencyKey, required: true })
  @ApiHeader({ name: BOT_AUTH_HEADER_NAMES.nonce, required: true })
  @ApiHeader({ name: BOT_AUTH_HEADER_NAMES.signature, required: true })
  @ApiHeader({ name: BOT_AUTH_HEADER_NAMES.timestamp, required: true })
  @ApiCreatedResponse({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['launchId', 'expiresAt'],
      properties: {
        launchId: {
          type: 'string',
          minLength: 43,
          maxLength: 43,
          pattern: '^[A-Za-z0-9_-]+$',
        },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Некорректное тело запроса' })
  @ApiUnauthorizedResponse({ description: 'Bot request не прошёл проверку' })
  @ApiConflictResponse({
    description: 'Подтверждённый entitlement отсутствует',
  })
  @ApiServiceUnavailableResponse({
    description: 'Fail-closed отказ зависимости или конфигурации',
  })
  async issueChallenge(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<IssuedTelegramAuthChallenge> {
    const parsed = issueTelegramAuthChallengeRequestSchema.safeParse(body);
    const authenticated = request.authenticatedBot;
    if (
      !parsed.success ||
      !authenticated ||
      authenticated.telegramUserId !== parsed.data.telegramUserId
    ) {
      throw new BadRequestException('Telegram challenge request is invalid');
    }
    return this.challenges.issue(authenticated);
  }

  @Post('confirm')
  @HttpCode(200)
  @UseGuards(BotRequestAuthenticationGuard)
  @ApiOperation({
    summary: 'Подтвердить pending-вход кодом из WebView',
    description:
      'Внутренний bot→API endpoint. Подтверждает только pending-запись той же Telegram identity и не создаёт browser session.',
  })
  @ApiHeader({ name: BOT_AUTH_HEADER_NAMES.credentialId, required: true })
  @ApiHeader({ name: BOT_AUTH_HEADER_NAMES.idempotencyKey, required: true })
  @ApiHeader({ name: BOT_AUTH_HEADER_NAMES.nonce, required: true })
  @ApiHeader({ name: BOT_AUTH_HEADER_NAMES.signature, required: true })
  @ApiHeader({ name: BOT_AUTH_HEADER_NAMES.timestamp, required: true })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['telegramUserId', 'confirmationCode'],
      properties: {
        telegramUserId: { type: 'string', pattern: '^[1-9][0-9]{0,19}$' },
        confirmationCode: {
          type: 'string',
          pattern: '^[0-9A-HJKMNP-TV-Z]{8}$',
        },
      },
    },
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: { status: { type: 'string', enum: ['BOT_CONFIRMED'] } },
    },
  })
  @ApiBadRequestResponse({ description: 'Некорректное тело запроса' })
  @ApiUnauthorizedResponse({ description: 'Bot request или код невалиден' })
  @ApiConflictResponse({ description: 'Idempotency key использован иначе' })
  @ApiTooManyRequestsResponse({ description: 'Превышен лимит попыток' })
  @ApiServiceUnavailableResponse({
    description: 'Fail-closed отказ зависимости или конфигурации',
  })
  async confirmPendingLogin(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConfirmedTelegramLogin> {
    const parsed = confirmTelegramLoginRequestSchema.safeParse(body);
    const authenticated = request.authenticatedBot;
    if (
      !parsed.success ||
      !authenticated ||
      authenticated.telegramUserId !== parsed.data.telegramUserId
    ) {
      throw new BadRequestException('Telegram confirmation request is invalid');
    }
    return confirmedTelegramLoginSchema.parse(
      await this.pendingLogins.confirm(
        authenticated,
        parsed.data.confirmationCode,
      ),
    );
  }
}
