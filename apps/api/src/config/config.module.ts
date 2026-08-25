import { Global, Module } from '@nestjs/common';
import type { DestinationStream } from 'pino';

import { apiEnvironmentProvider } from './environment';

export const API_LOG_DESTINATION = Symbol('API_LOG_DESTINATION');
export const DEFAULT_API_LOG_DESTINATION = Symbol(
  'DEFAULT_API_LOG_DESTINATION',
);
export type ApiLogDestination =
  DestinationStream | typeof DEFAULT_API_LOG_DESTINATION;

const apiLogDestinationProvider = {
  provide: API_LOG_DESTINATION,
  useValue: DEFAULT_API_LOG_DESTINATION as ApiLogDestination,
};

@Global()
@Module({
  providers: [apiEnvironmentProvider, apiLogDestinationProvider],
  exports: [apiEnvironmentProvider, apiLogDestinationProvider],
})
export class ApiConfigModule {}
