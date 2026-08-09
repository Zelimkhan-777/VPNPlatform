import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { API_ENVIRONMENT, type ApiEnvironment } from './config/environment';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const environment = app.get<ApiEnvironment>(API_ENVIRONMENT);
  await app.listen(environment.API_PORT, environment.API_HOST);
}

void bootstrap();
