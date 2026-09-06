import {
    Body,
    Controller,
    Post,
    Req,
    UseGuards,
    UsePipes,
    ValidationPipe,
} from '@nestjs/common';
import type { Request } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';

import { SchoolYearRolloverDto } from './dto/school-year-rollover.dto';
import { SchoolYearRolloverService } from './school-year-rollover.service';

/** Được áp chính sách cho **mọi trường**. */
const ROLLOVER_ALL_SCHOOLS_ROLES = [
    'director',
    'director_la',
    'saleadmin',
    'salesadmin_la',
];

/**
 * Áp môn học + chính sách đã duyệt của năm học trước sang năm học sau.
 *
 * Tách khỏi `SubjectsController` vì controller đó chưa gắn guard nào, còn ở đây
 * là thao tác tạo hàng loạt môn học và chính sách.
 *
 * Nhân viên kinh doanh (`sales`) cũng được áp, nhưng chỉ cho trường mình phụ
 * trách — cùng quy ước phạm vi "own" như `POLICY_VIEW_OWN_ROLES`. Chính sách
 * tạo ra luôn ở trạng thái nháp nên vẫn phải đi qua quy trình duyệt.
 */
@Controller('school-year-rollover')
@UseGuards(JwtAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class SchoolYearRolloverController {
    constructor(private readonly service: SchoolYearRolloverService) {}

    /** Xem trước: môn nào được tạo, bao nhiêu chính sách đi theo, môn nào bị bỏ qua. */
    @Post('preview')
    @Roles(...ROLLOVER_ALL_SCHOOLS_ROLES, 'sales')
    preview(@Body() dto: SchoolYearRolloverDto, @Req() req: Request) {
        return this.service.rollover({
            ...dto,
            dryRun: true,
            ...this.scopeOf(req),
        });
    }

    @Post()
    @Roles(...ROLLOVER_ALL_SCHOOLS_ROLES, 'sales')
    rollover(@Body() dto: SchoolYearRolloverDto, @Req() req: Request) {
        return this.service.rollover({
            ...dto,
            dryRun: dto.dryRun !== false,
            ...this.scopeOf(req),
        });
    }

    /**
     * Chỉ role quản lý được áp cho trường bất kỳ; còn lại (sales) bị khoá theo
     * `schools.employee_id`. Phạm vi luôn suy ra từ token, không nhận từ body.
     */
    private scopeOf(req: Request): { restrictToEmployeeId?: number } {
        const roles = req.user?.roles ?? [];
        if (roles.some((role) => ROLLOVER_ALL_SCHOOLS_ROLES.includes(role))) {
            return {};
        }
        return { restrictToEmployeeId: req.user?.id };
    }
}
