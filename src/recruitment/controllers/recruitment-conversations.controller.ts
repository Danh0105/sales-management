import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/role-guard';
import { Roles } from '../../auth/roles.decorator';
import { RecruitmentAiLimitsService } from '../channels/recruitment-ai-limits.service';
import { RecruitmentChannelEventOperationsService } from '../channels/recruitment-channel-event-operations.service';
import { RecruitmentConversationControlService } from '../channels/recruitment-conversation-control.service';
import { RecruitmentHrAlertService } from '../channels/recruitment-hr-alert.service';
import { RecruitmentHrConsoleService } from '../channels/recruitment-hr-console.service';
import { RecruitmentRuntimeControlService } from '../channels/recruitment-runtime-control.service';
import { RecruitmentOutboxOperationsService } from '../channels/recruitment-outbox-operations.service';
import { RecruitmentOutboxApprovalService } from '../channels/recruitment-outbox-approval.service';
import { RecruitmentZaloQuarantineService } from '../channels/recruitment-zalo-quarantine.service';
import {
  CancelHrMessageDto,
  ExcludeChannelEventDto,
  HrAlertQueryDto,
  HrMessageDto,
  MarkOutboxSentDto,
  OperationsListQueryDto,
  OutboxQueryDto,
  ResumeConversationAiDto,
  RetryOutboxDto,
  RuntimeControlChangeDto,
} from '../dto/channel-operations.dto';
import {
  hrActor,
  RECRUITMENT_OPERATIONS_ROLES,
  RECRUITMENT_TAKEOVER_ROLES,
  RECRUITMENT_VIEW_ROLES,
} from '../recruitment.roles';
import {
  ApproveOutboxDto,
  EditAndApproveOutboxDto,
  RejectOutboxDto,
} from '../dto/outbox-approval.dto';
import {
  ApprovalListQueryDto,
  ConversationListQueryDto,
  ConversationMessagesQueryDto,
} from '../dto/hr-console.dto';
import { recruitmentValidationPipe } from './validation';

/**
 * HR điều khiển hội thoại kênh (P3-6): tiếp quản, gửi tin thay AI, trả lại AI,
 * đóng. Chỉ nhóm `RECRUITMENT_TAKEOVER_ROLES` được thao tác; người chỉ-xem đọc
 * được trạng thái. Audit ghi đúng nhân viên thao tác (JWT), không bao giờ actor AI.
 */
@ApiTags('Recruitment')
@ApiBearerAuth()
@Controller('recruitment/conversations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...RECRUITMENT_VIEW_ROLES)
@UsePipes(recruitmentValidationPipe())
export class RecruitmentConversationsController {
  constructor(
    private readonly control: RecruitmentConversationControlService,
    private readonly hrConsole: RecruitmentHrConsoleService,
  ) {}

  /** Danh sách hội thoại kênh cho màn HR (tìm theo tên/SĐT ứng viên, lọc chế độ, tin chờ duyệt). */
  @Get()
  list(@Query() query: ConversationListQueryDto) {
    return this.hrConsole.listConversations(query);
  }

  /** Lịch sử tin (ứng viên / AI / HR) kèm trạng thái gửi và duyệt của từng tin. */
  @Get(':id/messages')
  messages(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: ConversationMessagesQueryDto,
  ) {
    return this.hrConsole.conversationMessages(id, query.limit);
  }

  @Get(':id/control')
  getControl(@Param('id', ParseIntPipe) id: number) {
    return this.control.control(id);
  }

  @Post(':id/takeover')
  @HttpCode(200)
  @Roles(...RECRUITMENT_TAKEOVER_ROLES)
  takeover(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.control.takeover(id, hrActor(req.user!));
  }

  /** Tin HR → hội thoại canonical + outbox (sender gửi). Không qua OpenClaw. */
  @Post(':id/messages')
  @HttpCode(200)
  @Roles(...RECRUITMENT_TAKEOVER_ROLES)
  sendMessage(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: HrMessageDto,
    @Req() req: Request,
  ) {
    return this.control.sendHumanMessage(id, dto, hrActor(req.user!));
  }

  @Post(':id/resume-ai')
  @HttpCode(200)
  @Roles(...RECRUITMENT_TAKEOVER_ROLES)
  resumeAi(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResumeConversationAiDto,
    @Req() req: Request,
  ) {
    return this.control.resumeAi(id, dto, hrActor(req.user!));
  }

  @Post(':id/close')
  @HttpCode(200)
  @Roles(...RECRUITMENT_TAKEOVER_ROLES)
  close(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.control.close(id, hrActor(req.user!));
  }
}

/**
 * Vận hành kênh (P3-6): đối soát outbox UNKNOWN, handoff đang mở, cảnh báo HR.
 * Đọc: nhóm xem; thao tác: `RECRUITMENT_OPERATIONS_ROLES`.
 */
@ApiTags('Recruitment')
@ApiBearerAuth()
@Controller('recruitment/operations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...RECRUITMENT_VIEW_ROLES)
@UsePipes(recruitmentValidationPipe())
export class RecruitmentOperationsController {
  constructor(
    private readonly outbox: RecruitmentOutboxOperationsService,
    private readonly approvals: RecruitmentOutboxApprovalService,
    private readonly control: RecruitmentConversationControlService,
    private readonly alerts: RecruitmentHrAlertService,
    private readonly quarantine: RecruitmentZaloQuarantineService,
    private readonly events: RecruitmentChannelEventOperationsService,
    private readonly runtime: RecruitmentRuntimeControlService,
    private readonly aiLimits: RecruitmentAiLimitsService,
    private readonly hrConsole: RecruitmentHrConsoleService,
  ) {}

  /** Số liệu tổng quan cho dashboard HR + hoạt động tuyển dụng gần đây (không nội dung). */
  @Get('overview')
  overview() {
    return this.hrConsole.overview();
  }

  /** P3.2 — hàng đợi tin AI theo nhóm (chờ duyệt / đã duyệt / đã gửi / từ chối / lỗi). */
  @Get('approvals')
  listApprovals(@Query() query: ApprovalListQueryDto) {
    return this.hrConsole.listApprovals(query);
  }

  /** P3.2 — chi tiết một tin AI: bản nháp, lịch sử duyệt, ngữ cảnh hội thoại. */
  @Get('approvals/:id')
  approvalDetail(@Param('id', ParseIntPipe) id: number) {
    return this.hrConsole.approvalDetail(id);
  }

  /** P3-7.3 / G8 — trạng thái dừng khẩn AI / worker / outbound. */
  @Get('runtime-controls')
  runtimeControls() {
    return this.runtime.state();
  }

  /** Dừng khẩn (không cần restart): AI / WORKER / OUTBOUND, có lý do, ghi audit. */
  @Post('runtime-controls/stop')
  @HttpCode(200)
  @Roles(...RECRUITMENT_OPERATIONS_ROLES)
  stopRuntime(@Body() dto: RuntimeControlChangeDto, @Req() req: Request) {
    return this.runtime.set(dto.scopes, true, dto.reason, hrActor(req.user!));
  }

  @Post('runtime-controls/resume')
  @HttpCode(200)
  @Roles(...RECRUITMENT_OPERATIONS_ROLES)
  resumeRuntime(@Body() dto: RuntimeControlChangeDto, @Req() req: Request) {
    return this.runtime.set(dto.scopes, false, dto.reason, hrActor(req.user!));
  }

  /** Lượt / token AI hôm nay, tháng này so với trần; pilot bật hay không (không lộ danh sách). */
  @Get('ai-usage')
  aiUsage() {
    return this.aiLimits.summary();
  }

  /** Số request Send API + chi phí ước tính theo ledger bền (không PII). */
  @Get('outbound-usage')
  outboundUsage() {
    return this.outbox.usage();
  }

  /** P3-7.3 — số event inbox theo trạng thái + lý do, tin đang chờ (không nội dung). */
  @Get('events/stats')
  eventStats() {
    return this.events.stats();
  }

  /**
   * P3-7.3 R1 — loại event inbox (RECEIVED / FAILED) khỏi xử lý nghiệp vụ, vd. tin thử nội bộ.
   * Giữ dòng + metadata để audit, xoá nội dung; gọi lại cùng lý do → idempotent.
   */
  @Post('events/:id/exclude')
  @HttpCode(200)
  @Roles(...RECRUITMENT_OPERATIONS_ROLES)
  excludeEvent(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ExcludeChannelEventDto,
    @Req() req: Request,
  ) {
    return this.events.exclude(id, dto.reason, hrActor(req.user!));
  }

  /** P3-7.2A — số request webhook đang/đã cách ly theo trạng thái (không nội dung). */
  @Get('webhook-quarantine')
  quarantineStats() {
    return this.quarantine.stats();
  }

  /**
   * Xác minh hồi tố request đã cách ly — chỉ chạy được khi đã có OA secret key và đã
   * tắt quarantine. Khớp chữ ký → vào inbox; không khớp → xoá nội dung.
   */
  @Post('webhook-quarantine/verify')
  @HttpCode(200)
  @Roles(...RECRUITMENT_OPERATIONS_ROLES)
  verifyQuarantine(@Req() req: Request) {
    return this.quarantine.verifyAll(hrActor(req.user!));
  }

  @Get('outbox')
  listOutbox(@Query() query: OutboxQueryDto) {
    return this.outbox.list(query);
  }

  /** P3.2 — HR duyệt nguyên văn phản hồi AI. */
  @Post('outbox/:id/approve')
  @HttpCode(200)
  @Roles(...RECRUITMENT_OPERATIONS_ROLES)
  approveOutbox(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApproveOutboxDto,
    @Req() req: Request,
  ) {
    return this.approvals.approve(id, dto.requestId, hrActor(req.user!));
  }

  /** P3.2 — HR sửa nội dung và duyệt trong một transaction. */
  @Post('outbox/:id/edit-and-approve')
  @HttpCode(200)
  @Roles(...RECRUITMENT_OPERATIONS_ROLES)
  editAndApproveOutbox(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: EditAndApproveOutboxDto,
    @Req() req: Request,
  ) {
    return this.approvals.editAndApprove(
      id,
      dto.text,
      dto.requestId,
      hrActor(req.user!),
    );
  }

  /** P3.2 — HR từ chối, không gửi phản hồi AI. */
  @Post('outbox/:id/reject')
  @HttpCode(200)
  @Roles(...RECRUITMENT_OPERATIONS_ROLES)
  rejectOutbox(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectOutboxDto,
    @Req() req: Request,
  ) {
    return this.approvals.reject(
      id,
      dto.reason,
      dto.requestId,
      hrActor(req.user!),
    );
  }

  /** Xác nhận Zalo đã nhận — không mở kết nối nào. */
  @Post('outbox/:id/mark-sent')
  @HttpCode(200)
  @Roles(...RECRUITMENT_OPERATIONS_ROLES)
  markSent(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MarkOutboxSentDto,
    @Req() req: Request,
  ) {
    return this.outbox.markSent(id, dto, hrActor(req.user!));
  }

  /** Gửi lại (có thể trùng) — bắt buộc `confirmDuplicateRisk: true`. */
  @Post('outbox/:id/retry')
  @HttpCode(200)
  @Roles(...RECRUITMENT_OPERATIONS_ROLES)
  retry(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RetryOutboxDto,
    @Req() req: Request,
  ) {
    return this.outbox.retry(id, dto, hrActor(req.user!));
  }

  @Post('outbox/:id/dead-letter')
  @HttpCode(200)
  @Roles(...RECRUITMENT_OPERATIONS_ROLES)
  deadLetter(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.outbox.deadLetter(id, hrActor(req.user!));
  }

  /** Huỷ tin HR đang chờ gửi (PENDING / RETRY) — không bao giờ gửi lại; có audit. */
  @Post('outbox/:id/cancel')
  @HttpCode(200)
  @Roles(...RECRUITMENT_OPERATIONS_ROLES)
  cancelHrMessage(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelHrMessageDto,
    @Req() req: Request,
  ) {
    return this.outbox.cancelHrMessage(id, dto.reason, hrActor(req.user!));
  }

  @Get('handoffs')
  handoffs(@Query() query: OperationsListQueryDto) {
    return this.control.listOpenHandoffs(query.limit);
  }

  @Get('alerts')
  listAlerts(@Query() query: HrAlertQueryDto) {
    return this.alerts.list(query);
  }

  @Post('alerts/:id/acknowledge')
  @HttpCode(200)
  @Roles(...RECRUITMENT_OPERATIONS_ROLES)
  acknowledge(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.alerts.acknowledge(id, hrActor(req.user!));
  }
}
