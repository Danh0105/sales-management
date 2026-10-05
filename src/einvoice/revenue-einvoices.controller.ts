import {
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { AuthUser } from '../type/auth-user.type';
import { RevenueEInvoicesService } from './revenue-einvoices.service';

type RequestWithUser = Request & { user: AuthUser };

/** Cùng nhóm được ghi dữ liệu thu chi (xem RealExpensesController). */
const WRITE_ROLES = [
  'accountant',
  'ketoan_congno',
  'ketoan_truong',
  'troly_gd',
  'director',
];
const SALESADMIN_ROLES = ['saleadmin', 'salesadmin', 'salesadmin_la'];

@Controller('school-expenses/:id/subjects/:subjectId/einvoices')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...WRITE_ROLES)
export class RevenueEInvoicesController {
  constructor(private readonly service: RevenueEInvoicesService) {}

  @Get()
  @Roles(...WRITE_ROLES, ...SALESADMIN_ROLES)
  list(
    @Param('id', ParseIntPipe) id: number,
    @Param('subjectId', ParseIntPipe) subjectId: number,
  ) {
    return this.service.list(id, subjectId);
  }

  /** Nút "Đẩy hóa đơn" ở bảng Hóa Đơn: gộp các dòng "Xuất HĐ Cty" chưa có hóa đơn thành 1 hóa đơn nháp. */
  @Post('drafts')
  exportDrafts(
    @Param('id', ParseIntPipe) id: number,
    @Param('subjectId', ParseIntPipe) subjectId: number,
    @Req() req: RequestWithUser,
  ) {
    return this.service.exportDrafts(id, subjectId, req.user);
  }

  /** KTT "Bỏ liên kết nháp" sau khi đã xóa hóa đơn nháp trên portal Viettel. */
  @Delete(':einvoiceId')
  @Roles('ketoan_truong')
  unlink(
    @Param('id', ParseIntPipe) id: number,
    @Param('subjectId', ParseIntPipe) subjectId: number,
    @Param('einvoiceId', ParseIntPipe) einvoiceId: number,
    @Req() req: RequestWithUser,
  ) {
    return this.service.unlink(id, subjectId, einvoiceId, req.user);
  }
}
