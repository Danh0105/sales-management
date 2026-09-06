import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    ParseIntPipe,
    Patch,
    Post,
    Put,
    Query,
    UseGuards,
    UsePipes,
    ValidationPipe,
} from '@nestjs/common';

import { SubjectCatalogsService } from './subject-catalog.service';
import { CreateSubjectCatalogDto } from './dto/create-subject-catalog.dto';
import { UpdateSubjectCatalogDto } from './dto/update-subject-catalog.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';

/** Vai trò được quản lý danh mục môn học. */
const CATALOG_ADMIN_ROLES = ['saleadmin', 'salesadmin_la'];

@Controller('subject-catalogs')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class SubjectCatalogsController {
    constructor(private readonly service: SubjectCatalogsService) { }

    /**
     * Danh sách môn để chọn. Mặc định chỉ trả môn đang dùng.
     * `?includeInactive=true` (màn quản lý của sales admin) trả cả môn đã ngừng dùng.
     */
    @Get()
    findAll(
        @Query('includeInactive') includeInactive?: string,
        @Query('search') search?: string,
    ) {
        return this.service.findAll({
            includeInactive: includeInactive === 'true' || includeInactive === '1',
            search,
        });
    }

    @Get(':id')
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.service.findOne(id);
    }

    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(...CATALOG_ADMIN_ROLES)
    @Post()
    create(@Body() dto: CreateSubjectCatalogDto) {
        return this.service.create(dto);
    }

    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(...CATALOG_ADMIN_ROLES)
    @Put(':id')
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateSubjectCatalogDto,
    ) {
        return this.service.update(id, dto);
    }

    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(...CATALOG_ADMIN_ROLES)
    @Patch(':id')
    patch(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateSubjectCatalogDto,
    ) {
        return this.service.update(id, dto);
    }

    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(...CATALOG_ADMIN_ROLES)
    @Delete(':id')
    remove(@Param('id', ParseIntPipe) id: number) {
        return this.service.remove(id);
    }
}
