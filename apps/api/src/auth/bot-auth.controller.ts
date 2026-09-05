import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  BOT_AUTH_HEADER_NAMES,
  issueTelegramAuthChallengeRequestSchema,
  type IssuedTelegramAuthChallenge,
} from '@vpn-platform/contracts';

import { BotAuthChallengeService } from './bot-auth-challenge.service';
import { BotRequestAuthenticationGuard } from './bot-request-authentication.guard';
import type { AuthenticatedBotRequest } from './bot-request-authentication.service';

interface AuthenticatedRequest {
  authenticatedBot?: AuthenticatedBotRequest;
}

@ApiTags('auth')
@Controller('auth/telegram')
export class BotAuthController {
  constructor(
    @Inject(BotAuthChallengeService)
    private readonly challenges: BotAuthChallengeService,
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
}
