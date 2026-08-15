import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
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
  ApiOkResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  nodeAgentAcknowledgementSchema,
  type NodeAgentAcknowledgement,
  type NodeAgentConfigurationSnapshot,
} from '@vpn-platform/contracts';

import { NodeAgentCredentialService } from '../orchestration/node-agent-credential.service';
import { OrchestrationService } from '../orchestration/orchestration.service';
import { NodeAgentConfigurationService } from './node-agent-configuration.service';
import { NodeAgentHeartbeatService } from './node-agent-heartbeat.service';

@ApiTags('node-agent')
@ApiBearerAuth()
@Controller('node-agent/v1')
export class NodeAgentController {
  constructor(
    @Inject(NodeAgentCredentialService)
    private readonly credentials: NodeAgentCredentialService,
    @Inject(OrchestrationService)
    private readonly orchestration: OrchestrationService,
    @Inject(NodeAgentConfigurationService)
    private readonly configuration: NodeAgentConfigurationService,
    @Inject(NodeAgentHeartbeatService)
    private readonly heartbeats: NodeAgentHeartbeatService,
  ) {}

  @Get('configuration')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Получить снимок желаемого состояния ноды',
    description:
      'Возвращает lifecycle grants аутентифицированной ноды со статусом `healthy`, `draining`, доступная `disabled` или аварийная `quarantined` (emergency revoke-all), и только ей нужные client credentials. Не содержит URL, device ID или credential-хешей.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'desiredConfigVersion',
        'appliedConfigVersion',
        'pendingAcknowledgement',
        'grants',
        'routes',
      ],
      properties: {
        desiredConfigVersion: { type: 'integer', minimum: 0 },
        appliedConfigVersion: { type: 'integer', minimum: 0 },
        pendingAcknowledgement: {
          type: 'object',
          nullable: true,
          additionalProperties: false,
          required: ['nodeSyncJobId', 'targetVersion', 'snapshotHash'],
          properties: {
            nodeSyncJobId: { type: 'string', format: 'uuid' },
            targetVersion: { type: 'integer', minimum: 0 },
            snapshotHash: {
              type: 'string',
              pattern: '^[a-f0-9]{64}$',
            },
          },
        },
        grants: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'id',
              'status',
              'expiresAt',
              'desiredVersion',
              'appliedVersion',
              'revokedAt',
              'dataPlaneCredential',
            ],
            properties: {
              id: { type: 'string', format: 'uuid' },
              status: {
                type: 'string',
                enum: ['PENDING', 'ACTIVE', 'REVOKED'],
              },
              expiresAt: { type: 'string', format: 'date-time' },
              desiredVersion: { type: 'integer', minimum: 0 },
              appliedVersion: { type: 'integer', minimum: 0 },
              revokedAt: {
                type: 'string',
                format: 'date-time',
                nullable: true,
              },
              dataPlaneCredential: {
                type: 'string',
                format: 'uuid',
                nullable: true,
              },
            },
          },
        },
        routes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'activationVersion',
              'endpoint',
              'profile',
              'publicConfig',
            ],
            properties: {
              activationVersion: { type: 'integer', minimum: 1 },
              endpoint: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'host', 'addressKind', 'port', 'priority'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  host: { type: 'string', minLength: 1, maxLength: 253 },
                  addressKind: {
                    type: 'string',
                    enum: ['HOSTNAME', 'IPV4', 'IPV6'],
                  },
                  port: { type: 'integer', minimum: 1, maximum: 65_535 },
                  priority: { type: 'integer', minimum: 0 },
                },
              },
              profile: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'id',
                  'profileKey',
                  'version',
                  'protocolKind',
                  'transportKind',
                  'securityKind',
                  'clientCompatibility',
                  'priority',
                ],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  profileKey: { type: 'string', format: 'uuid' },
                  version: { type: 'integer', minimum: 1 },
                  protocolKind: {
                    type: 'string',
                    enum: ['VLESS', 'WIREGUARD'],
                  },
                  transportKind: {
                    type: 'string',
                    enum: ['TCP', 'WEBSOCKET', 'GRPC'],
                  },
                  securityKind: {
                    type: 'string',
                    enum: ['NONE', 'TLS', 'REALITY'],
                  },
                  clientCompatibility: {
                    type: 'string',
                    enum: ['HAPP'],
                  },
                  priority: { type: 'integer', minimum: 0 },
                },
              },
              publicConfig: {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'tlsServerName', 'displayName'],
                properties: {
                  kind: { type: 'string', enum: ['VLESS_TCP_TLS'] },
                  tlsServerName: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 253,
                  },
                  displayName: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128,
                  },
                },
              },
            },
          },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Недействительная credential ноды' })
  async configurationSnapshot(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<NodeAgentConfigurationSnapshot> {
    const snapshot = await this.credentials.withAuthenticatedNodeTransaction(
      extractBearerToken(authorization),
      (nodeId, transaction) =>
        this.configuration.snapshotInTransaction(transaction, nodeId),
    );
    if (!snapshot) {
      throw new UnauthorizedException('Node agent credential is invalid');
    }
    return snapshot;
  }

  @Post('heartbeats')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Зафиксировать серверное время последнего контакта ноды',
    description:
      'Принимается только от credential ноды со статусом `healthy`, `draining`, доступная `disabled` или аварийная `quarantined`. Не меняет статус ноды и не принимает время от агента.',
  })
  @ApiNoContentResponse({ description: 'Heartbeat принят' })
  @ApiUnauthorizedResponse({ description: 'Недействительная credential ноды' })
  async heartbeat(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<void> {
    const recorded = await this.credentials.withAuthenticatedNodeTransaction(
      extractBearerToken(authorization),
      (nodeId, transaction) =>
        this.heartbeats.recordInTransaction(transaction, nodeId),
    );
    if (recorded === null) {
      throw new UnauthorizedException('Node agent credential is invalid');
    }
  }

  @Post('acknowledgements')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Подтвердить применённую версию конфигурации ноды',
    description:
      'Принимает только credential конкретной ноды со статусом `healthy`, `draining`, доступная `disabled` или аварийная `quarantined`. Конфигурации, учётные данные пользователей и секреты в ответе не возвращаются.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['nodeSyncJobId', 'targetVersion', 'snapshotHash'],
      properties: {
        nodeSyncJobId: { type: 'string', format: 'uuid' },
        targetVersion: { type: 'integer', minimum: 0 },
        snapshotHash: {
          type: 'string',
          pattern: '^[a-f0-9]{64}$',
        },
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
    const acknowledgement = parseAcknowledgement(body);

    try {
      const result = await this.credentials.withAuthenticatedNodeTransaction(
        extractBearerToken(authorization),
        (nodeId, transaction) =>
          this.orchestration.acknowledgeNodeConfigInTransaction(transaction, {
            nodeId,
            ...acknowledgement,
          }),
      );
      if (result === null) {
        throw new UnauthorizedException('Node agent credential is invalid');
      }
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
