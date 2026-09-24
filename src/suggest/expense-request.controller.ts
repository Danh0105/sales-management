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
import { ApproveExpenseDto } from './dto/expense/approve-expense.dto';
import { WithdrawExpenseDto } from './dto/expense/withdraw-expense.dto';
import { SaleAdminReviewExpenseDto } from './dto/expense/sale-admin-review-expense.dto';
import { ConfirmNoteDto } from './dto/expense/confirm-note.dto';
import { ConfirmCashReleasedDto } from './dto/expense/confirm-cash-released.dto';
import { ConfirmNotSpentDto } from './dto/expense/confirm-not-spent.dto';
import { FilterExpenseDto } from './dto/expense/filter-expense.dto';
import { UpdateReminderSettingDto } from './dto/expense/update-reminder-setting.dto';
import { CreateExpenseRequestDto } from './dto/expense/create-expense-request.dto';
import { UpdateExpenseRequestDto } from './dto/expense/update-expense-request.dto';
import { CreateStockIssueOrderDto } from './dto/expense/create-stock-issue-order.dto';
import { ReassignRepairDto } from './dto/expense/reassign-repair.dto';
import { CreateStockInReceiptDto } from './dto/expense/create-stock-in-receipt.dto';
import {
    DeclineAssignmentDto,
    ReplaceAssignmentDto,
} from './dto/expense/assignment.dto';

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

    /**
     * Chủ đề xuất sửa đề xuất đã gửi duyệt. Đề xuất đã được duyệt sẽ quay về
     * chờ duyệt để Giám đốc / Sales Admin duyệt lại (xem
     * `SuggestService.updateExpense`).
     */
    @Patch(':id')
    @Roles(ExpenseRole.SALES)
    @UseInterceptors(singleUpload)
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateExpenseRequestDto,
        @UploadedFile() file: Express.Multer.File,
        @Req() req: any,
    ) {
        if (!req.user) throw new UnauthorizedException('Chưa đăng nhập');
        const fileUrl = file ? `/uploads/suggest/${file.filename}` : undefined;
        return this.service.updateExpense(id, dto, fileUrl, req.user);
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
    @Roles(ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN, ExpenseRole.CHIEF_ACCOUNTANT)
    approve(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ApproveExpenseDto,
        @Req() req: any,
    ) {
        return this.service.approveExpense(id, req.user, dto);
    }

    @Post(':id/reject')
    @Roles(ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN, ExpenseRole.CHIEF_ACCOUNTANT)
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
    @Roles(ExpenseRole.DEBT_ACCOUNTANT, ExpenseRole.CHIEF_ACCOUNTANT)
    paymentOrder(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: CreatePaymentOrderDto,
        @Req() req: any,
    ) {
        return this.service.createExpensePaymentOrder(id, dto, req.user);
    }

    /** Sửa lệnh chi đã lập — các bước sau (xuất tiền, nhận tiền) phải làm lại. */
    @Post(':id/payment-order/edit')
    @Roles(ExpenseRole.DEBT_ACCOUNTANT, ExpenseRole.CHIEF_ACCOUNTANT)
    editPaymentOrder(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: CreatePaymentOrderDto,
        @Req() req: any,
    ) {
        return this.service.editExpensePaymentOrder(id, dto, req.user);
    }

    /** Xoá 1 tệp đính kèm — dùng ở form xác nhận xuất tiền để gỡ tệp up nhầm. */
    @Delete(':id/attachments/:attachmentId')
    @Roles(
        ExpenseRole.DEBT_ACCOUNTANT,
        ExpenseRole.TREASURER,
        ExpenseRole.CHIEF_ACCOUNTANT,
    )
    deleteAttachment(
        @Param('id', ParseIntPipe) id: number,
        @Param('attachmentId', ParseIntPipe) attachmentId: number,
        @Req() req: any,
    ) {
        return this.service.deleteExpenseAttachment(id, attachmentId, req.user);
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

    // ========== THIẾT BỊ TỪ NHÀ CUNG CẤP (equipmentSource = SUPPLIER) ==========
    // Không gắn @Roles: người xử lý/nghiệm thu do Giám đốc chỉ định có thể
    // thuộc bất kỳ phòng ban nào — state machine kiểm tra đúng người.

    /** Người xử lý lập phiếu nhập kho thật. */
    @Post(':id/stock-in-receipt')
    stockInReceipt(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: CreateStockInReceiptDto,
        @Req() req: any,
    ) {
        if (!req.user) throw new UnauthorizedException('Chưa đăng nhập');
        return this.service.createStockInReceipt(id, dto, req.user);
    }

    /** Người nghiệm thu xác nhận hoàn thành — đề xuất chạy về Quản lý thu chi. */
    @Post(':id/stock-in-accept')
    @UseInterceptors(multiUpload)
    stockInAccept(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ConfirmNoteDto,
        @UploadedFiles() files: Express.Multer.File[],
        @Req() req: any,
    ) {
        if (!req.user) throw new UnauthorizedException('Chưa đăng nhập');
        return this.service.confirmStockInAccepted(
            id,
            req.user,
            dto.note,
            toAttachments(files),
        );
    }

    // ================= GIAO VIỆC: người bàn giao + người hỗ trợ =================

    /**
     * Người bàn giao / người hỗ trợ từ chối việc được giao. Không gắn @Roles:
     * người hỗ trợ có thể thuộc bất kỳ phòng ban nào — service kiểm tra đúng
     * người được giao.
     */
    @Post(':id/assignments/decline')
    declineAssignment(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: DeclineAssignmentDto,
        @Req() req: any,
    ) {
        if (!req.user) throw new UnauthorizedException('Chưa đăng nhập');
        return this.service.declineAssignment(id, req.user, dto.reason);
    }

    /** Giám đốc/Sales Admin chọn người thay thế cho người đã từ chối. */
    @Post(':id/assignments/:assignmentId/replace')
    @Roles(ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN, ExpenseRole.CHIEF_ACCOUNTANT)
    replaceAssignment(
        @Param('id', ParseIntPipe) id: number,
        @Param('assignmentId', ParseIntPipe) assignmentId: number,
        @Body() dto: ReplaceAssignmentDto,
        @Req() req: any,
    ) {
        return this.service.replaceAssignment(
            id,
            assignmentId,
            req.user,
            dto.employeeId,
        );
    }

    /** Đề xuất sửa chữa: phòng kỹ thuật xác nhận nhận việc. */
    @Post(':id/repair-accept')
    @Roles(ExpenseRole.TECHNICAL)
    repairAccept(
        @Param('id', ParseIntPipe) id: number,
        @Req() req: any,
    ) {
        return this.service.acceptRepair(id, req.user);
    }

    /** Đề xuất sửa chữa: phòng kỹ thuật từ chối, bắt buộc có lý do. */
    @Post(':id/repair-reject')
    @Roles(ExpenseRole.TECHNICAL)
    repairReject(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: RejectExpenseDto,
        @Req() req: any,
    ) {
        return this.service.rejectRepair(id, req.user, dto.reason);
    }

    /** Đề xuất sửa chữa: Giám đốc/Sales Admin chỉ định người khác sau khi bị từ chối. */
    @Post(':id/repair-reassign')
    @Roles(
        ExpenseRole.DIRECTOR,
        ExpenseRole.SALES_ADMIN,
        ExpenseRole.CHIEF_ACCOUNTANT,
    )
    repairReassign(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ReassignRepairDto,
        @Req() req: any,
    ) {
        return this.service.reassignRepair(
            id,
            req.user,
            dto.assignedTechnicianId,
        );
    }

    // ================= THỦ QUỸ =================

    @Post(':id/cash-released')
    @Roles(ExpenseRole.TREASURER, ExpenseRole.CHIEF_ACCOUNTANT)
    @UseInterceptors(multiUpload)
    cashReleased(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ConfirmCashReleasedDto,
        @UploadedFiles() files: Express.Multer.File[],
        @Req() req: any,
    ) {
        return this.service.confirmCashReleased(
            id,
            req.user,
            dto.note,
            toAttachments(files),
            dto.fundSource,
        );
    }

    @Post(':id/fund-returned')
    @Roles(ExpenseRole.TREASURER, ExpenseRole.CHIEF_ACCOUNTANT)
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
