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
import { RecruitmentChannelEventOperationsService } from '../channels/recruitment-channel-event-operations.service';
import { RecruitmentConversationControlService } from '../channels/recruitment-conversation-control.service';
import { RecruitmentHrAlertService } from '../channels/recruitment-hr-alert.service';
import { RecruitmentOutboxOperationsService } from '../channels/recruitment-outbox-operations.service';
import { RecruitmentZaloQuarantineService } from '../channels/recruitment-zalo-quarantine.service';
import {
  ExcludeChannelEventDto,
  HrAlertQueryDto,
  HrMessageDto,
  MarkOutboxSentDto,
  OperationsListQueryDto,
  OutboxQueryDto,
  ResumeConversationAiDto,
  RetryOutboxDto,
} from '../dto/channel-operations.dto';
import {
  hrActor,
  RECRUITMENT_OPERATIONS_ROLES,
  RECRUITMENT_TAKEOVER_ROLES,
  RECRUITMENT_VIEW_ROLES,
} from '../recruitment.roles';
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
  ) {}

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
    private readonly control: RecruitmentConversationControlService,
    private readonly alerts: RecruitmentHrAlertService,
    private readonly quarantine: RecruitmentZaloQuarantineService,
    private readonly events: RecruitmentChannelEventOperationsService,
  ) {}

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
