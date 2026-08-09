import { Global, Module } from '@nestjs/common';

import { apiEnvironmentProvider } from './environment';

@Global()
@Module({
  providers: [apiEnvironmentProvider],
  exports: [apiEnvironmentProvider],
})
export class ApiConfigModule {}
