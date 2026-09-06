// employee-fcm-token.controller.ts

import {
    Body,
    Controller,
    Delete,
    HttpCode,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard }
    from '../auth/jwt-auth.guard';

import { EmployeeFcmTokenService }
    from './employee-fcm-token.service';

@Controller('employee-fcm-token')
export class EmployeeFcmTokenController {
    constructor(
        private readonly service:
            EmployeeFcmTokenService,
    ) { }

    @UseGuards(JwtAuthGuard)
    @Post('save')
    async save(
        @Req() req,
        @Body()
        body: {
            token: string;
            platform?: string;
        },
    ) {
        return this.service.saveToken(
            req.user.id,
            body.token,
            body.platform,
        );
    }

    /**
     * Gọi lúc đăng xuất — gỡ đúng token của thiết bị đang đăng xuất, không đụng
     * các thiết bị khác của cùng nhân viên. Scope theo `req.user.id` để một
     * người không tự ý gỡ token của người khác dù biết được chuỗi token.
     */
    @UseGuards(JwtAuthGuard)
    @Delete()
    @HttpCode(200)
    async remove(
        @Req() req,
        @Body() body: { token: string },
    ) {
        await this.service.removeToken(req.user.id, body.token);
        return { removed: true };
    }
}