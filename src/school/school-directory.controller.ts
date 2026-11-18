import {
    Controller,
    Get,
    Param,
    ParseIntPipe,
    Query,
    UseGuards,
    UsePipes,
    ValidationPipe,
} from '@nestjs/common';

import { SchoolDirectoryQueryDto } from './dto/school-directory-query.dto';
import { SchoolDirectoryGuard } from './school-directory.guard';
import { SchoolDirectoryService } from './school-directory.service';

/**
 * Không cần JWT: máy chủ be.kidostudent không có tài khoản nhân viên. Thay vào
 * đó chặn theo địa chỉ gọi (`SchoolDirectoryGuard`) và chỉ trả cột danh mục.
 */
@Controller('school-directory')
@UseGuards(SchoolDirectoryGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class SchoolDirectoryController {
    constructor(private readonly directory: SchoolDirectoryService) {}

    @Get()
    findAll(@Query() query: SchoolDirectoryQueryDto) {
        return this.directory.findAll(query);
    }

    @Get(':id')
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.directory.findOne(id);
    }
}
