import {
    Body,
    Controller,
    Get,
    Post,
    Query,
    UseGuards,
    UsePipes,
    ValidationPipe,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';

import { MergeSubjectsDto } from './dto/merge-subjects.dto';
import { SubjectMergeService } from './subject-merge.service';

/**
 * Gộp môn học trùng nhau của cùng một trường.
 *
 * Tách khỏi `SubjectsController` vì controller đó chưa gắn guard nào, còn ở đây
 * là thao tác xoá dữ liệu không hoàn tác được — phải có xác thực và giới hạn
 * role.
 */
@Controller('subject-merge')
@UseGuards(JwtAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class SubjectMergeController {
    constructor(private readonly service: SubjectMergeService) {}

    /** Các nhóm môn trùng tên, kèm số bản ghi đang tham chiếu từng môn. */
    @Get('duplicates')
    @Roles('director', 'director_la', 'ketoan_truong', 'nhansu')
    duplicates(@Query('schoolId') schoolId?: string) {
        return this.service.findDuplicates(
            schoolId ? Number(schoolId) : undefined,
        );
    }

    /** Các bảng đang trỏ tới `subjects.id` — để đối chiếu trước khi gộp. */
    @Get('references')
    @Roles('director', 'director_la', 'ketoan_truong', 'nhansu')
    references() {
        return this.service.referencingTables();
    }

    @Post()
    @Roles('director')
    merge(@Body() dto: MergeSubjectsDto) {
        return this.service.merge({
            keepId: dto.keepId,
            mergeIds: dto.mergeIds,
            dryRun: dto.dryRun !== false,
        });
    }
}
