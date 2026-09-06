// employee-fcm-token.service.ts

import {
    Injectable,
} from '@nestjs/common';

import {
    InjectRepository,
} from '@nestjs/typeorm';

import {
    In,
    Repository,
} from 'typeorm';

import { EmployeeFcmToken }
    from './employee-fcm-token.entity';

@Injectable()
export class EmployeeFcmTokenService {
    constructor(
        @InjectRepository(
            EmployeeFcmToken,
        )
        private repo: Repository<EmployeeFcmToken>,
    ) { }

    async saveToken(
        employeeId: number,
        token: string,
        platform?: string,
    ) {
        const existed = await this.repo.findOne({
            where: { token },
        });

        if (existed) {
            existed.employeeId = employeeId;
            existed.platform = platform || existed.platform;

            return this.repo.save(existed);
        }

        return this.repo.save({
            employeeId,
            token,
            platform,
        });
    }

    async getTokens(
        employeeIds: number[],
    ) {
        return this.repo.find({
            where: {
                employeeId: In(
                    employeeIds,
                ),
            },
        });
    }

    async removeInvalidTokens(
        tokens: string[],
    ) {
        if (!tokens.length) return;

        await this.repo.delete({
            token: In(tokens),
        });
    }

    /** Gỡ đúng 1 thiết bị — gọi lúc đăng xuất, không đụng token của thiết bị khác. */
    async removeToken(
        employeeId: number,
        token: string,
    ) {
        await this.repo.delete({
            employeeId,
            token,
        });
    }
}