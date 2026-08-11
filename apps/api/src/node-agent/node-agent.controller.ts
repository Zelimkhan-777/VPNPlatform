import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  nodeAgentAcknowledgementSchema,
  type NodeAgentAcknowledgement,
} from '@vpn-platform/contracts';

import { NodeAgentCredentialService } from '../orchestration/node-agent-credential.service';
import { OrchestrationService } from '../orchestration/orchestration.service';

@ApiTags('node-agent')
@ApiBearerAuth()
@Controller('node-agent/v1')
export class NodeAgentController {
  constructor(
    @Inject(NodeAgentCredentialService)
    private readonly credentials: NodeAgentCredentialService,
    @Inject(OrchestrationService)
    private readonly orchestration: OrchestrationService,
  ) {}

  @Post('acknowledgements')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Подтвердить применённую версию конфигурации ноды',
    description:
      'Принимает только credential конкретной healthy-ноды. Конфигурации, учётные данные пользователей и секреты в ответе не возвращаются.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['nodeSyncJobId', 'targetVersion'],
      properties: {
        nodeSyncJobId: { type: 'string', format: 'uuid' },
        targetVersion: { type: 'integer', minimum: 0 },
      },
    },
  })
  @ApiNoContentResponse({ description: 'Подтверждение принято идемпотентно' })
  @ApiBadRequestResponse({ description: 'Неверное тело подтверждения' })
  @ApiUnauthorizedResponse({ description: 'Недействительная credential ноды' })
  @ApiConflictResponse({
    description:
      'Задача не принадлежит ноде или ещё не может быть подтверждена',
  })
  async acknowledge(
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<void> {
    const nodeId = await this.credentials.authenticate(
      extractBearerToken(authorization),
    );
    if (!nodeId) {
      throw new UnauthorizedException('Node agent credential is invalid');
    }
    const acknowledgement = parseAcknowledgement(body);

    try {
      await this.orchestration.acknowledgeNodeConfig({
        nodeId,
        ...acknowledgement,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Node sync job')) {
        throw new ConflictException('Node acknowledgement cannot be accepted');
      }
      throw error;
    }
  }
}

function parseAcknowledgement(body: unknown): NodeAgentAcknowledgement {
  const result = nodeAgentAcknowledgementSchema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException('Node acknowledgement is invalid');
  }
  return result.data;
}

function extractBearerToken(authorization: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
  return match?.[1] ?? '';
}
