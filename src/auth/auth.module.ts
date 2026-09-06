import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { Employee } from '../employee/employee.entity';
import { JwtStrategy } from './jwt.strategy';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ZaloService } from 'src/zalo/zalo.service';
import { EmployeeModule } from 'src/employee/employee.module';
import { FaceService } from './face.service';
import { FaceController } from './face.controller';

@Module({


    imports: [
        PassportModule,
        EmployeeModule,
        TypeOrmModule.forFeature([Employee]),
        JwtModule.registerAsync({
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => ({
                secret: configService.get<string>('JWT_SECRET'),
                signOptions: { expiresIn: '1d' },
            }),
        }),
    ],
    providers: [AuthService, JwtStrategy, ZaloService, FaceService],
    controllers: [AuthController, FaceController],
    exports: [PassportModule],
})
export class AuthModule { }