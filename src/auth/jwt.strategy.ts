import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Employee } from '../employee/employee.entity';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor(
        private configService: ConfigService,
        @InjectRepository(Employee)
        private readonly employeeRepo: Repository<Employee>,
    ) {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            secretOrKey: configService.get<string>('JWT_SECRET'),
        });
    }

    async validate(payload: any) {
        const id = Number(payload?.sub);
        if (!Number.isInteger(id) || id <= 0) {
            throw new UnauthorizedException('Token không hợp lệ');
        }

        // Quyền và trạng thái tài khoản phải lấy từ DB tại thời điểm request.
        // Không tiếp tục tin roles đã nằm trong JWT suốt 24 giờ sau khi HR thu
        // hồi quyền hoặc khoá tài khoản.
        const employee = await this.employeeRepo.findOne({
            where: { id },
            select: ['id', 'name', 'roles', 'isActive'],
        });
        if (!employee || employee.isActive === false) {
            throw new UnauthorizedException('Tài khoản không còn hoạt động');
        }

        return {
            id: employee.id,
            roles: employee.roles ?? [],
            name: employee.name,
            iat: payload.iat,
            exp: payload.exp,
        };
    }
}
