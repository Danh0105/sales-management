import {
    Controller,
    Get,
    Post,
    Body,
    Param,
    Delete,
    Patch,
    ParseIntPipe,
    UseGuards,
    UsePipes,
    ValidationPipe,
    Query,
    Req,
    UploadedFiles,
    UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { MAX_CONTRACT_FILES, PolicyService } from './policy.service';
import { CreatePolicyDto } from './dto/create-policy.dto';
import { UpdatePolicyDto } from './dto/update-policy.dto';
import { AdminUpdatePolicyDto } from './dto/admin-update.dto';
import { DirectorUpdatePolicyDto } from './dto/director-update-policy.dto';
import { Roles } from 'src/auth/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from 'src/auth/role-guard';
import { BlockReadOnlyGuard } from '../auth/read-only.guard';
import { PolicyStatsDto } from './dto/policy-stats.dto';
import { QueryPoliciesDto } from './dto/query-policies.dto';
import { QueryPoliciesPageDto } from './dto/query-policies-page.dto';
import {
    POLICY_VIEW_ALL_ROLES,
    POLICY_VIEW_PROVINCE_ROLES,
    POLICY_VIEW_ROLES,
    resolvePolicyScope,
} from './policy-scope';
import { PolicyStatus } from './policy.enum';

@Controller('policies')
export class PolicyController {
    constructor(private readonly service: PolicyService) { }
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles('saleadmin', 'salesadmin', 'salesadmin_la')
    /**
     * Nhận nhiều PDF một lần. `AnyFilesInterceptor` để chấp nhận cả field
     * `file` (FE cũ gửi một file) lẫn `files` (FE mới gửi nhiều) — không
     * bắt FE đổi tên field để khỏi gãy bản đang chạy.
     */
    @UseInterceptors(AnyFilesInterceptor({
        limits: { fileSize: 20 * 1024 * 1024, files: MAX_CONTRACT_FILES },
    }))
    @Post(':id/contract')
    uploadContract(
        @Param('id', ParseIntPipe) id: number,
        @UploadedFiles() files: Express.Multer.File[] | undefined,
        @Body('category') category: string | undefined,
        @Req() req: Request,
    ) {
        return this.service.uploadContract(
            id,
            files,
            {
                id: req.user!.id,
                name: req.user!.name,
            },
            category,
        );
    }

    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles('saleadmin', 'salesadmin', 'salesadmin_la')
    @Delete(':id/contract/:fileId')
    removeContract(
        @Param('id', ParseIntPipe) id: number,
        @Param('fileId') fileId: string,
    ) {
        return this.service.removeContract(id, fileId);
    }
    // ================= ADMIN =================
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles('director', 'director_la', 'saleadmin', 'salesadmin_la')
    @Patch(':id/admin-update')
    adminUpdateStatusNote(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: AdminUpdatePolicyDto,
        @Req() req: Request,
    ) {
        const roles = req.user!.roles ?? [];
        const isSalesAdmin = roles.some((role) =>
            ['saleadmin', 'salesadmin_la'].includes(role),
        );
        const isDirector = roles.some((role) =>
            ['director', 'director_la'].includes(role),
        );

        // Một số phiên bản FE dùng chung nút/endpoint duyệt và luôn gửi
        // DIRECTOR_APPROVED. Sales Admin không được phép tạo trạng thái duyệt
        // của Giám đốc; chuẩn hóa ở backend để cả client cũ cũng chạy đúng luồng.
        const effectiveDto =
            isSalesAdmin && !isDirector && dto.status === PolicyStatus.DIRECTOR_APPROVED
                ? { ...dto, status: PolicyStatus.SALE_ADMIN_APPROVED }
                : dto;
        const reviewer = {
            id: req.user!.id,
            name: req.user!.name,
            role: isDirector ? 'director' as const : 'salesadmin' as const,
        };
        return this.service.adminUpdateStatusNote(id, effectiveDto, reviewer);
    }
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles('director', 'director_la', 'saleadmin', 'salesadmin_la')
    @Patch(':id/director-update')
    directorUpdatePolicy(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: DirectorUpdatePolicyDto,
        @Req() req: Request,
    ) {
        const reviewer = {
            id: req.user!.id,
            name: req.user!.name,
        };

        const isSalesAdmin = req.user!.roles?.some((role) =>
            ['saleadmin', 'salesadmin_la'].includes(role),
        );

        return isSalesAdmin
            ? this.service.salesAdminUpdatePolicy(id, dto, reviewer)
            : this.service.directorUpdatePolicy(id, dto, reviewer);
    }

    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles('saleadmin', 'salesadmin_la')
    @Patch(':id/salesadmin-update')
    salesAdminUpdatePolicy(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: DirectorUpdatePolicyDto,
        @Req() req: Request,
    ) {
        const salesAdmin = {
            id: req.user!.id,
            name: req.user!.name,
        };
        return this.service.salesAdminUpdatePolicy(id, dto, salesAdmin);
    }

    @Get('stats/school')
    async getStatsBySchool(
        @Query('schoolId', ParseIntPipe) schoolId: number,
        @Query('subjectId') subjectId?: string,
        @Query('schoolYear') schoolYear?: string,
    ) {
        return this.service.getStatsBySchool({
            schoolId,
            subjectId: subjectId ? Number(subjectId) : undefined,
            schoolYear,
        });
    }
    /**
     * Số liệu thống kê chính sách của một nhân viên.
     *
     * Chỉ các role xem-toàn-bộ / theo-tỉnh được truyền `employeeId` tuỳ ý; còn
     * lại (kinh doanh và mọi role nhân viên khác) bị ép về **chính mình** —
     * `employeeId` trên query bị bỏ qua, không tin vào việc FE gửi đúng id.
     *
     * Cố ý không dùng `RolesGuard`: danh sách role nhân viên còn có các slug cũ
     * (`employee`, `employee_la`…) vẫn đang xem thống kê của mình, chặn theo
     * danh sách role là cắt mất họ.
     */
    @UseGuards(JwtAuthGuard)
    @Get('stats')
    async getStats(@Query() query: PolicyStatsDto, @Req() req: Request) {
        const roles = req.user?.roles ?? [];
        const canViewOthers = roles.some((role) =>
            [...POLICY_VIEW_ALL_ROLES, ...POLICY_VIEW_PROVINCE_ROLES].includes(role),
        );
        const employeeId = canViewOthers ? query.employeeId : req.user!.id;

        return this.service.getStats(employeeId, query.allStatuses);
    }
    // ================= CREATE =================
    @UseGuards(JwtAuthGuard, BlockReadOnlyGuard)
    @Post()
    create(@Body() dto: CreatePolicyDto) {
        return this.service.create(dto);
    }

    // ================= QUERY =================

    /**
     * Danh sách chính sách phân trang cho tab "Tất cả chính sách" của Giám đốc.
     * page/limit được clamp (mặc định 12, tối đa 100); ID và ngày sai vẫn trả 400.
     * Tham số lạ bị bỏ qua thay vì báo lỗi để FE gửi dư không làm hỏng tab.
     */
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(...POLICY_VIEW_ROLES)
    @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
    @Get('all')
    findAllPaginated(
        @Query() query: QueryPoliciesPageDto,
        @Req() req: Request,
    ) {
        return this.service.findAllPaginated(query, resolvePolicyScope(req.user));
    }

    /**
     * Danh sách tổng hợp mọi chính sách cho màn hình Director (tab "Tất cả chính sách").
     * Lọc / phân trang / sắp xếp đều chạy dưới database.
     * Phạm vi dữ liệu lấy từ access token — employeeId trong query chỉ là bộ lọc.
     */
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(...POLICY_VIEW_ROLES)
    @UsePipes(
        new ValidationPipe({
            whitelist: true,
            transform: true,
            forbidNonWhitelisted: true,
        }),
    )
    @Get('admin/all')
    findAllForAdmin(@Query() query: QueryPoliciesDto, @Req() req: Request) {
        return this.service.findAllForAdmin(query, resolvePolicyScope(req.user));
    }

    /** Tùy chọn cho 6 bộ lọc của FE, giới hạn trong phạm vi user được xem. */
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(...POLICY_VIEW_ROLES)
    @Get('filter-options')
    getFilterOptions(@Req() req: Request) {
        return this.service.getFilterOptions(resolvePolicyScope(req.user));
    }

    @Get()
    findAll() {
        return this.service.findAll();
    }

    @Get('subject/:subjectId')
    findBySubject(@Param('subjectId', ParseIntPipe) subjectId: number) {
        return this.service.findBySubject(subjectId);
    }

    @Get('history')
    getHistory(@Query('subjectId', ParseIntPipe) subjectId: number) {
        return this.service.getHistoryBySubject(subjectId);
    }

    @Get('history/policy/:policyId')
    getByPolicy(@Param('policyId', ParseIntPipe) policyId: number) {
        return this.service.getHistoryByPolicy(policyId);
    }

    @Get('by-history/:historyId')
    findByHistory(@Param('historyId', ParseIntPipe) historyId: number) {
        return this.service.findHistoryByCurrentHistoryId(historyId);
    }



    // ================= UPDATE =================
    @UseGuards(JwtAuthGuard, BlockReadOnlyGuard)
    @Patch(':id')
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdatePolicyDto,
    ) {
        return this.service.update(id, dto);
    }

    // ================= DELETE =================
    @UseGuards(JwtAuthGuard, BlockReadOnlyGuard)
    @Delete(':id')
    remove(@Param('id', ParseIntPipe) id: number) {
        return this.service.remove(id);
    }

    // ================= DETAIL =================
    @Get(':id')
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.service.findOne(id);
    }
}
