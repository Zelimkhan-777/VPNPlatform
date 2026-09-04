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
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  BOT_AUTH_HEADER_NAMES,
  activateTrialRequestSchema,
  type TrialActivation,
} from '@vpn-platform/contracts';

import { BotRequestAuthenticationGuard } from '../auth/bot-request-authentication.guard';
import type { AuthenticatedBotRequest } from '../auth/bot-request-authentication.service';
import { TrialActivationService } from './trial-activation.service';

interface AuthenticatedTrialRequest {
  authenticatedBot?: AuthenticatedBotRequest;
}

const trialActivationOpenApiSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'trialCampaignId',
    'subscriptionId',
    'planId',
    'startsAt',
    'expiresAt',
    'activatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    trialCampaignId: { type: 'string', format: 'uuid' },
    subscriptionId: { type: 'string', format: 'uuid' },
    planId: { type: 'string', format: 'uuid' },
    startsAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    activatedAt: { type: 'string', format: 'date-time' },
  },
};

const activateTrialRequestOpenApiSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['telegramUserId'],
  properties: {
    telegramUserId: {
      type: 'string',
      pattern: '^[1-9][0-9]{0,19}$',
    },
  },
};

@ApiTags('trial')
@Controller('trial')
export class TrialController {
  constructor(
    @Inject(TrialActivationService)
    private readonly activation: TrialActivationService,
  ) {}

  @Post('activate')
  @HttpCode(200)
  @UseGuards(BotRequestAuthenticationGuard)
  @ApiOperation({
    summary: 'Активировать доступный автоматический trial',
    description:
      'Внутренний bot→API endpoint. Кампания выбирается только сервером; Telegram identity подтверждается HMAC запроса.',
  })
  @ApiHeader({ name: BOT_AUTH_HEADER_NAMES.credentialId, required: true })
  @ApiHeader({ name: BOT_AUTH_HEADER_NAMES.idempotencyKey, required: true })
  @ApiHeader({ name: BOT_AUTH_HEADER_NAMES.nonce, required: true })
  @ApiHeader({ name: BOT_AUTH_HEADER_NAMES.signature, required: true })
  @ApiHeader({ name: BOT_AUTH_HEADER_NAMES.timestamp, required: true })
  @ApiBody({ required: true, schema: activateTrialRequestOpenApiSchema })
  @ApiOkResponse({ schema: trialActivationOpenApiSchema })
  @ApiBadRequestResponse({ description: 'Некорректное тело запроса' })
  @ApiUnauthorizedResponse({ description: 'Bot request не прошёл проверку' })
  @ApiConflictResponse({
    description: 'Trial недоступен или пользователь не eligible',
  })
  @ApiTooManyRequestsResponse({ description: 'Превышен лимит попыток' })
  @ApiServiceUnavailableResponse({
    description: 'Fail-closed отказ зависимости или конфигурации',
  })
  async activateTrial(
    @Body() body: unknown,
    @Req() request: AuthenticatedTrialRequest,
  ): Promise<TrialActivation> {
    const parsed = activateTrialRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('Trial activation request is invalid');
    }
    const authenticated = request.authenticatedBot;
    if (
      !authenticated ||
      authenticated.telegramUserId !== parsed.data.telegramUserId
    ) {
      throw new BadRequestException('Trial activation request is invalid');
    }
    return this.activation.activate(authenticated);
  }
}
