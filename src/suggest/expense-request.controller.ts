import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    ParseIntPipe,
    Patch,
    Post,
    Query,
    Req,
    UnauthorizedException,
    UploadedFile,
    UploadedFiles,
    UseGuards,
    UseInterceptors,
    UsePipes,
    ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { ExpenseRole } from './constants/expense-roles';
import { SuggestType } from './enums/suggest-type.enum';

import { SuggestService, UploadedAttachment } from './suggest.service';
import { CreatePaymentOrderDto } from './dto/expense/create-payment-order.dto';
import { RejectExpenseDto } from './dto/expense/reject-expense.dto';
import { WithdrawExpenseDto } from './dto/expense/withdraw-expense.dto';
import { SaleAdminReviewExpenseDto } from './dto/expense/sale-admin-review-expense.dto';
import { ConfirmNoteDto } from './dto/expense/confirm-note.dto';
import { ConfirmNotSpentDto } from './dto/expense/confirm-not-spent.dto';
import { FilterExpenseDto } from './dto/expense/filter-expense.dto';
import { UpdateReminderSettingDto } from './dto/expense/update-reminder-setting.dto';
import { CreateExpenseRequestDto } from './dto/expense/create-expense-request.dto';
import { CreateStockIssueOrderDto } from './dto/expense/create-stock-issue-order.dto';

const singleUpload = FileInterceptor('file', {
    storage: diskStorage({
        destination: './uploads/suggest',
        filename: (_, file, cb) => {
            const unique = Date.now() + '-' + Math.random();
            cb(null, unique + extname(file.originalname));
        },
    }),
});

const multiUpload = FilesInterceptor('files', 5, {
    storage: diskStorage({
        destination: './uploads/suggest',
        filename: (_, file, cb) => {
            const unique = Date.now() + '-' + Math.random();
            cb(null, unique + extname(file.originalname));
        },
    }),
});

function toAttachments(
    files?: Express.Multer.File[],
): UploadedAttachment[] | undefined {
    if (!files?.length) return undefined;
    return files.map((f) => ({
        fileUrl: `/uploads/suggest/${f.filename}`,
        fileName: f.originalname,
    }));
}

/**
 * Controller mỏng cho luồng ĐỀ XUẤT CHI — dùng chung SuggestService.
 * (Không tạo service riêng; state machine & nghiệp vụ nằm trong SuggestService.)
 */
@Controller('expense-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class ExpenseRequestController {
    constructor(private readonly service: SuggestService) { }

    // ================= SALES =================

    @Post()
    @Roles(ExpenseRole.SALES)
    @UseInterceptors(singleUpload)
    create(
        @Body() dto: CreateExpenseRequestDto,
        @UploadedFile() file: Express.Multer.File,
        @Req() req: any,
    ) {
        if (!req.user) throw new UnauthorizedException('Chưa đăng nhập');
        const fileUrl = file ? `/uploads/suggest/${file.filename}` : undefined;
        return this.service.create(
            { ...dto, type: SuggestType.EXPENSE_REQUEST },
            fileUrl,
            req.user,
        );
    }

    @Post(':id/cash-received')
    @Roles(ExpenseRole.SALES)
    cashReceived(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ConfirmNoteDto,
        @Req() req: any,
    ) {
        return this.service.confirmCashReceived(id, req.user, dto.note);
    }

    @Post(':id/confirm-spent')
    @Roles(ExpenseRole.SALES)
    @UseInterceptors(multiUpload)
    confirmSpent(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ConfirmNoteDto,
        @UploadedFiles() files: Express.Multer.File[],
        @Req() req: any,
    ) {
        return this.service.confirmSpent(
            id,
            req.user,
            dto.note,
            toAttachments(files),
        );
    }

    @Post(':id/confirm-not-spent')
    @Roles(ExpenseRole.SALES)
    confirmNotSpent(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ConfirmNotSpentDto,
        @Req() req: any,
    ) {
        return this.service.confirmNotSpent(id, req.user, dto.reason);
    }

    // ================= SALES ADMIN (kiểm duyệt) =================

    @Post(':id/sale-admin-review')
    @Roles(ExpenseRole.SALES_ADMIN)
    saleAdminReview(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: SaleAdminReviewExpenseDto,
        @Req() req: any,
    ) {
        return this.service.reviewExpenseBySaleAdmin(id, req.user, {
            status: dto.status,
            note: dto.note,
        });
    }

    // ============ DUYỆT (Giám đốc & Sales Admin ngang quyền) ============
    // Sales Admin duyệt/từ chối cùng chốt với Giám đốc; ràng buộc phân tách
    // nhiệm vụ nằm ở `assertExpenseTransition` (không tự duyệt đơn mình, không
    // làm hai bước kiểm soát liên tiếp), guard này chỉ chặn theo role.

    @Post(':id/approve')
    @Roles(ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN)
    approve(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
        return this.service.approveExpense(id, req.user);
    }

    @Post(':id/reject')
    @Roles(ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN)
    reject(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: RejectExpenseDto,
        @Req() req: any,
    ) {
        return this.service.rejectExpense(id, req.user, dto.reason);
    }

    /**
     * Chủ đề xuất tự rút đơn khi còn DRAFT / PENDING_APPROVAL. Giám đốc rút
     * hộ được đơn của bất kỳ ai (state machine miễn ràng buộc chủ đơn cho
     * riêng role DIRECTOR — xem `overrideRoles` trong expense-flow.state-machine.ts).
     */
    @Post(':id/withdraw')
    @Roles(ExpenseRole.SALES, ExpenseRole.DIRECTOR)
    withdraw(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: WithdrawExpenseDto,
        @Req() req: any,
    ) {
        return this.service.withdrawExpense(id, req.user, dto.reason);
    }

    /**
     * Giám đốc xoá hẳn đề xuất chi (chỉ khi chưa phát sinh dòng tiền — xem
     * `SuggestService.deleteExpense`). Có thông báo cho người tạo.
     */
    @Delete(':id')
    @Roles(ExpenseRole.DIRECTOR)
    remove(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
        return this.service.deleteExpense(id, req.user);
    }

    // ================= KẾ TOÁN CÔNG NỢ =================

    @Post(':id/payment-order')
    @Roles(ExpenseRole.DEBT_ACCOUNTANT)
    paymentOrder(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: CreatePaymentOrderDto,
        @Req() req: any,
    ) {
        return this.service.createExpensePaymentOrder(id, dto, req.user);
    }

    /** Kinh doanh xác nhận đã nhận thiết bị (nhánh đề xuất thiết bị) */
    @Post(':id/equipment-received')
    @Roles(ExpenseRole.SALES)
    equipmentReceived(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ConfirmNoteDto,
        @Req() req: any,
    ) {
        return this.service.confirmEquipmentReceived(id, req.user, dto.note);
    }

    // ================= PHÒNG KỸ THUẬT =================
    // Nhánh đề xuất thiết bị: kỹ thuật giữ vai trò tương đương kế toán công
    // nợ + thủ quỹ ở nhánh tiền (lên lệnh xuất kho, nhận lại thiết bị).

    @Post(':id/stock-issue-order')
    @Roles(ExpenseRole.TECHNICAL)
    stockIssueOrder(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: CreateStockIssueOrderDto,
        @Req() req: any,
    ) {
        return this.service.createExpenseStockIssueOrder(id, dto, req.user);
    }

    @Post(':id/equipment-returned')
    @Roles(ExpenseRole.TECHNICAL)
    equipmentReturned(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ConfirmNoteDto,
        @Req() req: any,
    ) {
        return this.service.confirmEquipmentReturned(id, req.user, dto.note);
    }

    // ================= THỦ QUỸ =================

    @Post(':id/cash-released')
    @Roles(ExpenseRole.TREASURER)
    @UseInterceptors(multiUpload)
    cashReleased(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ConfirmNoteDto,
        @UploadedFiles() files: Express.Multer.File[],
        @Req() req: any,
    ) {
        return this.service.confirmCashReleased(
            id,
            req.user,
            dto.note,
            toAttachments(files),
        );
    }

    @Post(':id/fund-returned')
    @Roles(ExpenseRole.TREASURER)
    fundReturned(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ConfirmNoteDto,
        @Req() req: any,
    ) {
        return this.service.confirmFundReturned(id, req.user, dto.note);
    }

    // ================= QUERY =================

    @Get('my-tasks')
    myTasks(@Req() req: any) {
        return this.service.myExpenseTasks(req.user);
    }

    @Get('reminder-settings')
    getReminderSettings() {
        return this.service.getExpenseReminderSettings();
    }

    @Patch('reminder-settings')
    @Roles(ExpenseRole.DIRECTOR)
    updateReminderSettings(@Body() dto: UpdateReminderSettingDto) {
        return this.service.updateExpenseReminderSettings(dto);
    }

    @Post('reminders/run')
    @Roles(ExpenseRole.DIRECTOR)
    runReminders() {
        return this.service.runExpenseReminders();
    }

    // Tắt/bật nhắc quá hạn cho riêng một đề xuất — không ảnh hưởng đề xuất khác.
    @Post(':id/mute-overdue-alert')
    @Roles(ExpenseRole.DIRECTOR)
    muteOverdueAlert(@Param('id', ParseIntPipe) id: number) {
        return this.service.setOverdueAlertMuted(id, true);
    }

    @Post(':id/unmute-overdue-alert')
    @Roles(ExpenseRole.DIRECTOR)
    unmuteOverdueAlert(@Param('id', ParseIntPipe) id: number) {
        return this.service.setOverdueAlertMuted(id, false);
    }

    @Get()
    findAll(@Query() filter: FilterExpenseDto, @Req() req: any) {
        return this.service.findAllExpense(filter, req.user);
    }

    @Get('grouped-by-employee')
    findAllGroupedByEmployee(
        @Query() filter: FilterExpenseDto,
        @Req() req: any,
    ) {
        return this.service.findAllExpenseGroupedByEmployee(filter, req.user);
    }

    @Get(':id')
    findOne(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
        return this.service.findOneExpense(id, req.user);
    }
}
