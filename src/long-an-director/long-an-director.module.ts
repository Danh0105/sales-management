import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { LongAnDirectorGuard } from './long-an-director.guard';
import { LongAnScopeService } from './long-an-scope.service';

@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [
    LongAnScopeService,
    { provide: APP_GUARD, useClass: LongAnDirectorGuard },
  ],
  exports: [LongAnScopeService],
})
export class LongAnDirectorModule {}
