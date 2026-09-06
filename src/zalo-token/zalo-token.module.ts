import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ZaloToken } from './zalo-token.entity';
import { ZaloTokenService } from './zalo-token.service';

@Module({
    imports: [TypeOrmModule.forFeature([ZaloToken])],
    providers: [ZaloTokenService],
    exports: [ZaloTokenService],
})
export class ZaloTokenModule { }