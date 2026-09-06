import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RealExpensesService } from './real-expenses.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { AuthUser } from '../type/auth-user.type';

type RequestWithUser = Request & { user: AuthUser };

/**
 * Kế toán trưởng (`ketoan_truong`) CHỈ ĐƯỢC XEM quản lý thu chi.
 * Các thao tác ghi (tạo/sửa/xóa/lưu) dùng WRITE_ROLES (không có ketoan_truong).
 * @Roles ở method override @Roles ở class (xem RolesGuard.getAllAndOverride).
 */
const WRITE_ROLES = ['accountant', 'ketoan_congno', 'troly_gd', 'director'];

@Controller('school-expenses')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('accountant', 'ketoan_congno', 'ketoan_truong', 'troly_gd', 'director')
export class RealExpensesController {
  constructor(private readonly realExpensesService: RealExpensesService) {}

  @Get('check-existed')
  checkExisted(
    @Query('schoolId') schoolId: string,
    @Query('periodId') periodId: string,
  ) {
    return this.realExpensesService.checkExisted(
      Number(schoolId),
      Number(periodId),
    );
  }

  @Post()
  @Roles(...WRITE_ROLES)
  create(@Body() body: any, @Req() req: RequestWithUser) {
    return this.realExpensesService.create(body, req.user);
  }

  @Get()
  findAll(@Query() query: any) {
    return this.realExpensesService.findAll(query);
  }

  @Get(':id/items')
  getItems(
    @Param('id') id: string,
    @Query('subjectId') subjectId: string,
  ) {
    return this.realExpensesService.getItems(Number(id), Number(subjectId));
  }

  @Get(':id/history')
  getHistory(@Param('id') id: string) {
    return this.realExpensesService.getHistory(Number(id));
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.realExpensesService.findOne(Number(id));
  }

  @Patch(':id')
  @Roles(...WRITE_ROLES)
  update(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: RequestWithUser,
  ) {
    return this.realExpensesService.update(
      Number(id),
      body,
      req.user,
    );
  }

  @Delete(':id')
  @Roles(...WRITE_ROLES)
  remove(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.realExpensesService.remove(Number(id), req.user);
  }

  @Post(':id/save-all')
  @Roles(...WRITE_ROLES)
  saveAll(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: RequestWithUser,
  ) {
    return this.realExpensesService.saveAll(
      Number(id),
      body,
      req.user,
    );
  }

  @Get(':id/summary')
  getSummary(
    @Param('id') id: string,
    @Query('subjectId') subjectId: string,
  ) {
    return this.realExpensesService.getSummary(
      Number(id),
      subjectId ? Number(subjectId) : undefined,
    );
  }
}
