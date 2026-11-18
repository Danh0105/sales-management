import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Employee } from '../employee/employee.entity';
import { RealtimeAuthService } from './realtime-auth.service';

@Global()
@Module({
  imports: [JwtModule.register({}), TypeOrmModule.forFeature([Employee])],
  providers: [RealtimeAuthService],
  exports: [RealtimeAuthService],
})
export class RealtimeAuthModule {}
