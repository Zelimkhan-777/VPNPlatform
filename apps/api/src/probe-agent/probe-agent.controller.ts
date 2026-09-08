import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  type ApiBodyOptions,
} from '@nestjs/swagger';
import {
  probeResultSubmissionOpenApiSchema,
  type AcceptedProbeResult,
} from '@vpn-platform/contracts';

import {
  extractProbeBearerSecret,
  ProbeIngestionService,
} from './probe-ingestion.service';

@ApiTags('probe-agent')
@ApiBearerAuth()
@Controller('probe-agent/v1')
export class ProbeAgentController {
  constructor(
    @Inject(ProbeIngestionService)
    private readonly ingestion: ProbeIngestionService,
  ) {}

  @Post('results')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Сохранить результат зарегистрированного внешнего probe',
    description:
      'Источник определяется только отзываемым bearer credential. Сервер сохраняет собственное время приёма, exact retry идемпотентен, а изменённый replay отклоняется.',
  })
  @ApiBody({
    schema: probeResultSubmissionOpenApiSchema as unknown as Extract<
      ApiBodyOptions,
      { schema: unknown }
    >['schema'],
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['probeResultId', 'receivedAt', 'replayed'],
      properties: {
        probeResultId: { type: 'string', format: 'uuid' },
        receivedAt: { type: 'string', format: 'date-time' },
        replayed: { type: 'boolean' },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Неверная схема или timestamp result' })
  @ApiUnauthorizedResponse({
    description: 'Credential источника недействителен',
  })
  @ApiConflictResponse({ description: 'Replay key связан с другими данными' })
  @ApiTooManyRequestsResponse({
    description: 'Превышен rate/cardinality limit',
  })
  @ApiServiceUnavailableResponse({
    description: 'Fail-closed limiter недоступен',
  })
  async record(
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Req() request: { ip: string },
  ): Promise<AcceptedProbeResult> {
    return this.ingestion.ingest(
      extractProbeBearerSecret(authorization),
      request.ip,
      body,
    );
  }
}
