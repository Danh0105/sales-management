import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Param,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import {
  Repository,
  DataSource,
  EntityManager,
  In,
  Not,
  SelectQueryBuilder,
} from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { Suggest } from './entities/suggest.entity';
import { SuggestHistory } from './entities/suggest-history.entity';
import { CreateSuggestDto } from './dto/create-suggest.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SuggestCreatedEvent } from './events/suggest-created.event';

import { SuggestStatus, EXPENSE_TERMINAL_STATUSES } from './SuggestStatus.enum';
import { SuggestReviewedEvent } from './events/suggest-reviewed.event';
import { SuggestApprovedEvent } from './events/suggest-approved.event';
import { Employee } from '../employee/employee.entity';
import { Policy } from '../policy/entities/policy.entity';
import { School } from '../school/schools.entity';
import { Ward } from '../ward/ward.entity';
import { EmployeeRegion } from '../employee-region-school/entities/employee-region.entity';
import { Subject } from '../subject/subject.entity';
import fixVietnamese from '../utils/fixVietnamese';
import { NotificationService } from '../notifications/services/notification.service';
import { SuggestGateway } from './suggest.gateway';
import { FcmService } from '../fcm/fcm.service';
import { EmployeeFcmToken } from '../employee-fcm-token/employee-fcm-token.entity';
import { NotificationType } from '../notifications/enums/notification-type.enum';

// ===== ĐỀ XUẤT CHI (EXPENSE_REQUEST) =====
import { SuggestType } from './enums/suggest-type.enum';
import { ExpenseAction } from './enums/expense-action.enum';
import { ExpenseRole } from './constants/expense-roles';
import {
  assertExpenseTransition,
  expenseActorForStatus,
} from './expense-flow.state-machine';
import { SuggestPaymentOrder } from './entities/suggest-payment-order.entity';
import { SuggestStockIssueOrder } from './entities/suggest-stock-issue-order.entity';
import { WarehouseService } from '../warehouse/warehouse.service';
import { ExpenseRequestKind } from './enums/expense-request-kind.enum';
import { CreateStockIssueOrderDto } from './dto/expense/create-stock-issue-order.dto';
import { SuggestAttachment } from './entities/suggest-attachment.entity';
import {
  DEFAULT_EXPENSE_REMINDERS_ENABLED,
  DEFAULT_REMIND_BEFORE_DAYS,
  EXPENSE_REMINDERS_ENABLED_KEY,
  REMIND_BEFORE_DAYS_KEY,
  SuggestReminderSetting,
} from './entities/suggest-reminder-setting.entity';
import { CreatePaymentOrderDto } from './dto/expense/create-payment-order.dto';
import { FundSource, FUND_SOURCE_LABEL } from './enums/expense-fund-source.enum';
import { UpdateExpenseRequestDto } from './dto/expense/update-expense-request.dto';
import { FilterExpenseDto } from './dto/expense/filter-expense.dto';
import { vnToday, vnYearMonth, diffDays } from './utils/vn-date';
import { isCronLeader } from '../utils/is-cron-leader';

export interface AuthUser {
  id: number;
  roles: string[];
  name?: string;
}

export interface UploadedAttachment {
  fileUrl: string;
  fileName: string;
}

@Injectable()
export class SuggestService {
  constructor(
    @InjectRepository(Suggest)
    private readonly repo: Repository<Suggest>,

    @InjectRepository(SuggestHistory)
    private readonly historyRepo: Repository<SuggestHistory>,

    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,

    @InjectDataSource()
    private readonly dataSource: DataSource,

    @InjectRepository(Policy)
    private readonly policyRepo: Repository<Policy>,

    @InjectRepository(SuggestReminderSetting)
    private readonly settingRepo: Repository<SuggestReminderSetting>,

    private readonly eventEmitter: EventEmitter2,

    private readonly notificationService: NotificationService,
    private readonly suggestGateway: SuggestGateway,
    private readonly fcmService: FcmService,
    private readonly warehouseService: WarehouseService,
  ) {}

  private readonly logger = new Logger(SuggestService.name);

  // ================= CREATE =================

  async create(dto: CreateSuggestDto, fileUrl?: string, user?: Employee) {
    // 👉 BƯỚC 1 (luồng ĐỀ XUẤT CHI): tạo là gửi duyệt luôn → PENDING_APPROVAL, báo Giám đốc
    if (dto.type === SuggestType.EXPENSE_REQUEST) {
      const actor = this.ensureUser(user as AuthUser);

      if (!actor.roles?.includes(ExpenseRole.SALES)) {
        throw new ForbiddenException(
          'Chỉ kinh doanh (sales) được tạo đề xuất chi',
        );
      }
      if (!dto.content) {
        throw new BadRequestException('Thiếu tiêu đề/nội dung đề xuất');
      }
      if (!dto.expectedPaymentDate) {
        throw new BadRequestException('Thiếu ngày dự kiến chi');
      }
      const hasSchool = dto.schoolId !== undefined && dto.schoolId !== null;
      if (hasSchool && !dto.schoolYear) {
        throw new BadRequestException('Thiếu năm học');
      }
      if (!hasSchool && (dto.wardId === undefined || dto.wardId === null)) {
        throw new BadRequestException('Thiếu xã/phường');
      }
      if (dto.expectedPaymentDate < vnToday()) {
        throw new BadRequestException(
          'Ngày dự kiến chi phải từ hôm nay trở đi',
        );
      }

      const kind = dto.requestKind ?? ExpenseRequestKind.CASH;

      const saved = await this.dataSource.transaction(async (manager) => {
        let school: School | undefined;
        let ward: Ward | undefined;

        if (hasSchool) {
          school = (await manager.findOne(School, {
            where: { id: dto.schoolId },
          })) ?? undefined;
          if (!school) {
            throw new BadRequestException('Trường không tồn tại');
          }

          if (!this.isValidSchoolYear(dto.schoolYear!)) {
            throw new BadRequestException('Năm học không hợp lệ');
          }

          const subjectCount = await manager.count(Subject, {
            where: {
              schoolId: dto.schoolId,
              schoolYear: dto.schoolYear,
            },
          });
          if (subjectCount === 0) {
            throw new BadRequestException(
              'Trường không có môn học trong năm học đã chọn',
            );
          }
        } else {
          ward = (await manager.findOne(Ward, {
            where: { id: dto.wardId },
          })) ?? undefined;
          if (!ward) {
            throw new BadRequestException('Xã/phường không tồn tại');
          }
        }

        const code = await this.generateCode(manager, 'suggest', 'code', 'DX');

        const suggest = manager.create(Suggest, {
          type: SuggestType.EXPENSE_REQUEST,
          requestKind: kind,
          content: dto.content,
          description: dto.description,
          // Số tiền được xác định khi kế toán lập lệnh chi, không thuộc bước
          // nhân viên kinh doanh tạo đề xuất.
          amount: null,
          expectedPaymentDate: dto.expectedPaymentDate,
          beneficiaryInfo: dto.beneficiaryInfo ?? null,
          participants: dto.participants ?? null,
          ...(school ? { schoolId: school.id, school } : {}),
          ...(dto.schoolYear ? { schoolYear: dto.schoolYear } : {}),
          ...(ward ? { wardId: ward.id, ward } : {}),
          ...(kind === ExpenseRequestKind.EQUIPMENT && dto.items?.length
            ? { requestedItems: dto.items }
            : {}),
          fileUrl,
          code,
          version: 1,
          status: SuggestStatus.PENDING_APPROVAL,
          createdBy: actor.id,
        });

        const s = await manager.save(suggest);

        if (fileUrl) {
          await this.saveExpenseAttachments(
            manager,
            s.id!,
            [{ fileUrl, fileName: fileUrl.split('/').pop() || 'file' }],
            actor.id,
          );
        }

        await this.writeExpenseLog(manager, {
          suggestId: s.id!,
          userId: actor.id,
          action: ExpenseAction.CREATE,
          fromStatus: null,
          toStatus: SuggestStatus.PENDING_APPROVAL,
        });

        return s;
      });

      await this.notifyExpense(
        {
          suggestId: saved.id!,
          title:
            kind === ExpenseRequestKind.EQUIPMENT
              ? '🧰 Đề xuất thiết bị mới'
              : '💰 Đề xuất chi mới',
          message:
            `Có ${kind === ExpenseRequestKind.EQUIPMENT ? 'đề xuất thiết bị' : 'đề xuất chi'} mới cần duyệt: ` +
            `${saved.code} - ${saved.content}`,
          senderId: actor.id,
          meta: { status: saved.status },
        },
        { roles: [ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN] },
      );

      return this.findOneExpense(saved.id!);
    }

    let payload: SuggestCreatedEvent | null = null;
    console.log(user);
    let receiverIds: number[] = [];
    let tokens: string[] = [];
    let message = '';

    const saved = await this.dataSource.transaction(async (manager) => {
      let ward: Ward | null = null;
      if (dto.wardId !== undefined) {
        ward = await manager.findOne(Ward, {
          where: { id: dto.wardId },
          relations: ['province'],
        });
        if (!ward) throw new NotFoundException('Xã/phường không tồn tại');

        const globalRoles = [
          'director',
          'director_la',
          'saleadmin',
          'salesadmin_la',
        ];
        const canManageAll = user?.roles?.some((role) =>
          globalRoles.includes(role),
        );
        if (!canManageAll) {
          const assigned = await manager
            .createQueryBuilder(EmployeeRegion, 'er')
            .where('er.employeeId = :employeeId', { employeeId: user?.id })
            .andWhere('(er.wardId = :wardId OR er.provinceId = :provinceId)', {
              wardId: ward.id,
              provinceId: ward.province_id,
            })
            .getExists();
          if (!assigned) {
            throw new ForbiddenException(
              'Bạn không phụ trách xã/phường này',
            );
          }
        }

        if (dto.policyId) {
          const policy = await manager.findOne(Policy, {
            where: { id: dto.policyId },
            relations: ['subject', 'subject.school', 'subject.school.ward'],
          });
          if (!policy) throw new NotFoundException('Chính sách không tồn tại');
          if (policy.subject?.school?.ward?.id !== ward.id) {
            throw new BadRequestException(
              'Chính sách không thuộc xã/phường đã chọn',
            );
          }
        }
      }

      // Đề xuất thường không có số tiền. `amount` chỉ thuộc luồng
      // EXPENSE_REQUEST và được xử lý ở nhánh phía trên.
      const {
        amount: _amount,
        type: _type,
        expectedPaymentDate: _expectedPaymentDate,
        beneficiaryInfo: _beneficiaryInfo,
        participants: _participants,
        schoolId: _schoolId,
        schoolYear: _schoolYear,
        ...suggestionDto
      } = dto;
      const suggest = manager.create(Suggest, {
        ...suggestionDto,
        type: SuggestType.SUGGESTION,
        amount: null,
        fileUrl,
        version: 1,
        policyId: dto.policyId,
        wardId: ward?.id ?? null,
        ward,
        createdBy: user?.id,
        status: dto.status ?? SuggestStatus.PENDING,
      });

      const saved = await manager.save(suggest);

      // =================================================
      // GET RECEIVERS
      // =================================================

      const employees = await manager
        .createQueryBuilder(Employee, 'e')
        .where(`e.roles && ARRAY[:...roles]::text[]`, {
          roles: ['saleadmin', 'director', 'ketoan_congno', 'thuquy'],
        })
        .getMany();

      receiverIds = employees
        .map((e) => e.id)
        .filter((id): id is number => !!id);

      // =================================================
      // GET FCM TOKENS
      // =================================================

      const fcmTokens = await manager.find(EmployeeFcmToken, {
        where: {
          employeeId: In(receiverIds),
        },
      });

      tokens = fcmTokens.map((t) => t.token).filter(Boolean);

      message = `${user?.name} gửi một đề xuất mới: "${dto.content?.slice(0, 30)}"`;

      payload = new SuggestCreatedEvent(
        saved.id!,
        message,
        receiverIds,
        tokens,
        user?.id,
      );

      const { policy, ...clean } = saved;

      await manager.save(SuggestHistory, {
        suggestId: saved.id,
        data: clean,
      });

      return saved;
    });

    // =================================================
    // EMIT EVENT AFTER COMMIT
    // =================================================

    this.eventEmitter.emit('suggest.created', payload);

    const meta = {
      suggestId: saved.id,
      content: dto.content?.slice(0, 100),
    };

    // =================================================
    // CREATE DB NOTIFICATION
    // =================================================

    const notifications = await this.notificationService.createNotifications({
      receiverIds,
      type: NotificationType.SUGGEST,
      entityId: saved.id,
      message,
      senderId: user?.id,
      meta,
    });

    // =================================================
    // SOCKET REALTIME
    // =================================================

    notifications.forEach((noti) => {
      const socketPayload = {
        id: noti.id,
        type: noti.type,
        entityId: noti.entityId,
        message: noti.message,
        isRead: noti.isRead,
        createdAt: noti.createdAt,
        createdBy: user?.id,
        meta,
      };

      // notification realtime
      this.suggestGateway.server
        .to(`user_${noti.receiverId}`)
        .emit('notification:new', socketPayload);

      // optional realtime suggest
      this.suggestGateway.server
        .to(`user_${noti.receiverId}`)
        .emit('suggest:new', {
          suggestId: saved.id,
          content: dto.content,
          createdBy: user?.id,
          createdAt: saved.createdAt,
        });
    });

    // =================================================
    // PUSH FCM
    // =================================================

    if (tokens.length > 0) {
      await this.fcmService.sendToMultiple(
        [...new Set(tokens)], // remove duplicate
        '💡 Đề xuất mới',
        message,
        {
          type: 'suggest',
          id: String(saved.id),
          url: `/director/suggest/${saved.id}`,
        },
      );
    }

    return saved;
  }
  // ================= UPDATE =================

  async update(
    id: number,
    dto: CreateSuggestDto,
    fileUrl?: string,
    user?: Employee,
  ) {
    let receiverIds: number[] = [];
    let tokens: string[] = [];
    let message = '';

    const saved = await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(Suggest, {
        where: { id },
      });

      if (!existing) {
        throw new NotFoundException('Suggest not found');
      }

      // =================================================
      // SAVE HISTORY
      // =================================================

      const snapshot = { ...existing };

      await manager.save(SuggestHistory, {
        suggestId: existing.id,
        data: snapshot,
        createdBy: user?.id,
      });

      // =================================================
      // UPDATE DATA
      // =================================================

      const {
        policyId,
        status,
        amount: _amount,
        type: _type,
        expectedPaymentDate: _expectedPaymentDate,
        beneficiaryInfo: _beneficiaryInfo,
        participants: _participants,
        schoolId: _schoolId,
        schoolYear: _schoolYear,
        ...rest
      } = dto;

      Object.assign(existing, rest);
      if (existing.type === SuggestType.SUGGESTION) {
        existing.amount = null;
      }

      if (fileUrl) {
        existing.fileUrl = fileUrl;
      }

      if (status !== undefined) {
        existing.status = status;
      }

      // =================================================
      // POLICY
      // =================================================

      if (policyId !== undefined) {
        if (policyId === null) {
          existing.policyId = null;
        } else {
          const policy = await manager.findOne(Policy, {
            where: {
              id: policyId,
            },
          });

          if (!policy) {
            throw new NotFoundException('Policy không tồn tại');
          }

          existing.policyId = policy.id;
        }
      }

      // =================================================
      // VERSION
      // =================================================

      existing.version = (existing.version ?? 1) + 1;

      const updated = await manager.save(existing);

      // =================================================
      // GET RECEIVERS
      // =================================================

      const employees = await manager
        .createQueryBuilder(Employee, 'e')
        .where(`e.roles && ARRAY[:...roles]::text[]`, {
          roles: ['saleadmin', 'director'],
        })
        .getMany();

      receiverIds = employees
        .map((e) => e.id)
        .filter((id): id is number => !!id);

      // =================================================
      // GET TOKENS
      // =================================================

      const fcmTokens = await manager.find(EmployeeFcmToken, {
        where: {
          employeeId: In(receiverIds),
        },
      });

      tokens = [...new Set(fcmTokens.map((t) => t.token).filter(Boolean))];

      const name = fixVietnamese(user?.name || '');

      message = `${name} đã cập nhật đề xuất #${updated.id}`;

      return updated;
    });

    // =================================================
    // META
    // =================================================

    const meta = {
      suggestId: saved.id,
      content: saved.content?.slice(0, 100),
    };

    // =================================================
    // CREATE DB NOTIFICATION
    // =================================================

    const notifications = await this.notificationService.createNotifications({
      receiverIds,
      type: NotificationType.SUGGEST,
      entityId: saved.id,
      message,
      senderId: user?.id,
      meta,
    });

    // =================================================
    // SOCKET REALTIME
    // =================================================

    notifications.forEach((noti) => {
      const socketPayload = {
        id: noti.id,
        type: noti.type,
        entityId: noti.entityId,
        message: noti.message,
        isRead: noti.isRead,
        createdAt: noti.createdAt,
        createdBy: user?.id,
        meta,
      };

      // notification realtime
      this.suggestGateway.server
        .to(`user_${noti.receiverId}`)
        .emit('notification:new', socketPayload);

      // suggest updated realtime
      this.suggestGateway.server
        .to(`user_${noti.receiverId}`)
        .emit('suggest:updated', {
          suggestId: saved.id,
          content: saved.content,
          status: saved.status,
          updatedBy: user?.id,
          updatedAt: saved.updatedAt,
        });
    });

    // =================================================
    // PUSH FCM
    // =================================================

    if (tokens.length > 0) {
      await this.fcmService.sendToMultiple(
        tokens,
        '📝 Đề xuất cập nhật',
        message,
        {
          type: 'suggest_update',
          id: String(saved.id),
          url: `/director/suggest/${saved.id}`,
        },
      );
    }

    return saved;
  }

  // ================= GET =================

  async findAll() {
    return this.repo.find({
      where: { type: SuggestType.SUGGESTION },
      relations: ['ward', 'policy'],
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: number) {
    const suggest = await this.repo.findOne({
      where: { id },
      relations: {
        ward: true,
        policy: {
          subject: {
            school: true,
          },
        },
      },
    });

    if (!suggest) {
      throw new NotFoundException('Suggest not found');
    }

    return suggest;
  }

  async findHistory(suggestId: number) {
    return this.historyRepo.find({
      where: { suggestId },
      relations: ['policy'],
      order: { snapshotAt: 'DESC' },
    });
  }

  // ================= DELETE (optional) =================

  async remove(id: number, user?: Employee) {
    const suggest = await this.repo.findOne({
      where: { id },
    });

    if (!suggest) {
      throw new NotFoundException('Suggest not found');
    }

    // 🔒 chỉ cho xoá khi PENDING
    if (suggest.status !== 'PENDING') {
      throw new BadRequestException('Chỉ được xoá khi đang chờ');
    }

    // 🔒 chỉ chủ sở hữu được xoá
    if (suggest.createdBy !== user?.id) {
      throw new ForbiddenException('Không có quyền xoá');
    }

    await this.repo.remove(suggest);

    return { message: 'Deleted successfully' };
  }

  async reviewBySaleAdmin(
    id: number,
    status: SuggestStatus,
    user: Employee,
    rejectReason?: string,
  ) {
    let payload: SuggestReviewedEvent | null = null;

    if (!user) {
      throw new UnauthorizedException('User không hợp lệ');
    }
    const saved = await this.dataSource.transaction(async (manager) => {
      const suggest = await manager.findOne(Suggest, {
        where: { id },
      });

      if (!suggest) {
        throw new NotFoundException('Suggest not found');
      }
      if (suggest.status === SuggestStatus.APPROVED) {
        throw new BadRequestException(
          'Đã được director duyệt, không cần saleadmin xử lý',
        );
      }
      // 🔒 role
      if (
        !user.roles?.some((r: string) =>
          [
            'saleadmin',
            'salesadmin_la',
            'ketoan_truong',
            'troly_gd',
            'director',
            'director_la',
          ].includes(r),
        )
      ) {
        throw new ForbiddenException('Không có quyền xử lý đề xuất');
      }

      // 🔒 status hợp lệ
      if (![SuggestStatus.REVIEWED, SuggestStatus.REJECTED].includes(status)) {
        throw new BadRequestException('Chỉ được REVIEWED hoặc REJECTED');
      }

      // 🔒 chỉ xử lý khi PENDING
      if (suggest.status !== SuggestStatus.PENDING) {
        throw new BadRequestException('Chỉ xử lý khi PENDING');
      }

      // 📸 history
      await manager.save(SuggestHistory, {
        suggestId: suggest.id,
        data: { ...suggest },
        createdBy: user.id,
      });

      // 🔥 update
      suggest.status = status;
      suggest.reviewedBy = user.id;

      if (status === SuggestStatus.REJECTED) {
        if (!rejectReason) {
          throw new BadRequestException('Phải có lý do từ chối');
        }
        suggest.rejectReason = rejectReason;
      } else {
        suggest.rejectReason = null;
      }

      const saved = await manager.save(suggest);

      // Đây chỉ là bước kiểm duyệt TRUNG GIAN — giám đốc vẫn cần tự thấy
      // "cần duyệt" để quyết định cuối, nên CHỈ đánh dấu đã đọc cho đúng
      // người vừa kiểm duyệt, không đụng tới thông báo của người khác.
      await this.notificationService.markAsReadByTypeEntityForReceiver(
        NotificationType.SUGGEST,
        suggest.id!,
        user.id!,
      );

      // ================= NOTIFY =================

      // 👤 người tạo
      const creator = await manager.findOne(Employee, {
        where: {
          id: suggest.createdBy,
        },

        select: {
          id: true,
        },
      });

      const creatorId = creator?.id;

      // 👨‍💼 director
      const directors = await manager
        .createQueryBuilder(Employee, 'e')
        .select(['e.id'])
        .where(`'director' = ANY(e.roles)`)
        .getMany();

      const directorIds = directors
        .map((d) => d.id)
        .filter((id): id is number => !!id);

      const reviewedReceiverIds = [
        ...(creatorId ? [creatorId] : []),
        ...directorIds,
      ];

      // 📱 lấy hết token của mọi thiết bị (không chỉ 1 token/người)
      const reviewedFcmTokens = await manager.find(EmployeeFcmToken, {
        where: { employeeId: In(reviewedReceiverIds) },
      });
      const reviewedTokens = reviewedFcmTokens.map((t) => t.token).filter(Boolean);

      let message = '';
      if (status === SuggestStatus.REVIEWED) {
        message = `${user?.name} đã kiểm tra đề xuất #${suggest.id}, chờ duyệt`;
      } else {
        message = `${user?.name} đã từ chối đề xuất #${suggest.id}`;
      }
      payload = new SuggestReviewedEvent(
        saved.id!,

        message,

        reviewedReceiverIds,

        reviewedTokens,

        user.id!,

        status === SuggestStatus.REVIEWED ? 'APPROVED' : 'REJECTED',

        rejectReason,
      );

      return saved;
    });

    // 🔥 emit AFTER commit
    if (payload) {
      this.eventEmitter.emit('suggest.reviewed', payload);
    }

    return saved;
  }
  async approveByDirector(
    id: number,
    status: SuggestStatus,
    user: Employee,
    rejectReason?: string,
  ) {
    let payload: SuggestApprovedEvent | null = null;

    if (!user) {
      throw new UnauthorizedException('User không hợp lệ');
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const suggest = await manager.findOne(Suggest, {
        where: { id },
      });

      if (!suggest) {
        throw new NotFoundException('Suggest not found');
      }

      if (suggest.approvedBy) {
        throw new BadRequestException('Suggest đã được director xử lý');
      }

      // 🔒 role
      if (
        !user.roles?.some((r: string) =>
          ['director', 'director_la', 'troly_gd'].includes(r),
        )
      ) {
        throw new ForbiddenException('Không có quyền duyệt đề xuất');
      }

      // 🔒 status hợp lệ
      if (![SuggestStatus.APPROVED, SuggestStatus.REJECTED].includes(status)) {
        throw new BadRequestException('Chỉ được APPROVED hoặc REJECTED');
      }

      // 📸 history
      await manager.save(SuggestHistory, {
        suggestId: suggest.id,
        data: { ...suggest },
        createdBy: user.id,
      });

      // 🔥 update
      suggest.status = status;
      suggest.approvedBy = user.id;

      if (status === SuggestStatus.REJECTED) {
        if (!rejectReason) {
          throw new BadRequestException('Phải có lý do từ chối');
        }
        suggest.rejectReason = rejectReason;
      } else {
        suggest.rejectReason = null;
      }

      const saved = await manager.save(suggest);

      // Đã chốt duyệt/từ chối — thông báo "cần duyệt" cũ (gửi cả saleadmin,
      // director, ketoan_congno, thuquy) hết ý nghĩa với TẤT CẢ người nhận,
      // không riêng người vừa duyệt. Đánh dấu trước khi phát sự kiện tạo
      // thông báo kết quả bên dưới (cùng type+entityId) để không lỡ tay đánh
      // dấu luôn thông báo kết quả vừa tạo.
      await this.notificationService.markAllAsReadByTypeAndEntity(
        NotificationType.SUGGEST,
        suggest.id!,
      );

      // ================= NOTIFY =================

      // 👤 lấy creator (CHỈ 1 LẦN)
      const creator = await manager.findOne(Employee, {
        where: { id: suggest.createdBy },
      });

      const creatorId = creator?.id;

      // 🔤 message
      const name = fixVietnamese(user?.name || '');

      const message =
        status === SuggestStatus.APPROVED
          ? `${name} đã phê duyệt đề xuất #${suggest.id}`
          : `${name} đã từ chối đề xuất #${suggest.id}`;

      // 🔥 payload chuẩn
      const receiverIds = [creatorId].filter((id): id is number => !!id);

      // 📱 lấy hết token của mọi thiết bị người tạo (không chỉ 1 token)
      const approvedFcmTokens = await manager.find(EmployeeFcmToken, {
        where: { employeeId: In(receiverIds) },
      });
      const tokens = approvedFcmTokens.map((t) => t.token).filter(Boolean);

      payload = new SuggestApprovedEvent({
        suggestId: saved.id!,

        message,

        receiverIds,

        tokens,

        actorId: user.id!,
      });

      return saved;
    });

    // 🔥 emit AFTER commit
    if (payload) {
      this.eventEmitter.emit('suggest.approved', payload);
    }

    return saved;
  }
  async getStatsByPolicy() {
    const results = await this.repo
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.policy', 'p')
      .leftJoinAndSelect('p.subject', 'sub')
      .leftJoinAndSelect('sub.school', 'sch')
      .where('s.status = :status', {
        status: SuggestStatus.APPROVED,
      })
      .orderBy('p.id', 'DESC')
      .addOrderBy('s.issueDate', 'DESC')
      .getMany();

    const map = new Map<number, any>();

    for (const suggest of results) {
      const policyId = suggest.policy?.id;

      if (!policyId) continue;

      if (!map.has(policyId)) {
        map.set(policyId, {
          policyId,
          subjectName: suggest.policy?.subject?.name ?? null,
          schoolName: suggest.policy?.subject?.school?.name ?? null,
          total: 0,
          suggests: [],
        });
      }

      const item = map.get(policyId);

      item.total += 1;

      item.suggests.push({
        id: suggest.id,
        content: suggest.content,
        component: suggest.component,
        description: suggest.description,
        issueDate: suggest.issueDate,
        fileUrl: suggest.fileUrl,
      });
    }

    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }
  async findByEmployee(employeeId: number) {
    return this.repo.find({
      where: { createdBy: employeeId, type: SuggestType.SUGGESTION },
      relations: ['ward', 'policy', 'policy.subject', 'policy.subject.school'],
      order: { createdAt: 'DESC' },
    });
  }

  // ============================================================
  // =============== LUỒNG ĐỀ XUẤT CHI (EXPENSE) ================
  // ============================================================

  private ensureUser(user?: AuthUser): AuthUser {
    if (!user?.id) {
      throw new UnauthorizedException('User không hợp lệ');
    }
    return user;
  }

  /**
   * Sinh mã tuần tự theo tháng (DX-YYYYMM-xxxx / LC-YYYYMM-xxxx /
   * XK-YYYYMM-xxxx).
   * Advisory lock để 2 request song song không trùng mã.
   */
  private async generateCode(
    manager: EntityManager,
    table: 'suggest' | 'suggest_payment_order' | 'suggest_stock_issue_order',
    column: 'code',
    prefixLetter: 'DX' | 'LC' | 'XK',
  ): Promise<string> {
    const prefix = `${prefixLetter}-${vnYearMonth()}-`;

    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `${table}_${column}_${prefix}`,
    ]);

    const row: { code: string } | undefined = (
      await manager.query(
        `SELECT ${column} AS code FROM ${table} WHERE ${column} LIKE $1 ORDER BY ${column} DESC LIMIT 1`,
        [`${prefix}%`],
      )
    )[0];

    const seq = row ? parseInt(row.code.slice(prefix.length), 10) + 1 : 1;

    return prefix + String(seq).padStart(4, '0');
  }

  /**
   * Người thực hiện bước gần nhất trên đề xuất — dùng để chặn một người làm
   * hai chốt kiểm soát liên tiếp.
   *
   * Lấy bản ghi lịch sử mới nhất bất kể loại: mọi dòng trong `suggest_history`
   * đều là một thao tác có chủ thể trên đúng đề xuất đó (tạo đơn, kiểm duyệt
   * chính sách, chuyển trạng thái), nên "người vừa động vào đơn này" là đúng
   * thứ cần so.
   */
  private async lastExpenseActorId(
    manager: EntityManager,
    suggestId: number,
  ): Promise<number | null> {
    const last = await manager.findOne(SuggestHistory, {
      where: { suggestId },
      order: { id: 'DESC' },
    });
    return last?.userId ?? null;
  }

  private async writeExpenseLog(
    manager: EntityManager,
    data: {
      suggestId: number;
      userId: number;
      action: ExpenseAction;
      fromStatus?: SuggestStatus | null;
      toStatus?: SuggestStatus | null;
      note?: string | null;
    },
  ) {
    await manager.save(SuggestHistory, {
      suggestId: data.suggestId,
      userId: data.userId,
      action: data.action,
      fromStatus: data.fromStatus ?? null,
      toStatus: data.toStatus ?? null,
      note: data.note ?? null,
      data: {},
    });
  }

  private async saveExpenseAttachments(
    manager: EntityManager,
    suggestId: number,
    files: UploadedAttachment[] | undefined,
    uploadedBy: number,
  ) {
    if (!files?.length) return;

    await manager.save(
      SuggestAttachment,
      files.map((f) => ({
        suggestId,
        fileUrl: f.fileUrl,
        fileName: f.fileName,
        uploadedBy,
      })),
    );
  }

  /**
   * Gửi thông báo cho luồng đề xuất chi: DB + socket (NotificationService)
   * + push FCM. Không để lỗi FCM làm hỏng nghiệp vụ.
   */
  private async notifyExpense(
    payload: {
      suggestId: number;
      title: string;
      message: string;
      senderId?: number;
      meta?: Record<string, any>;
    },
    target: { roles?: string[]; userIds?: number[] },
  ) {
    const roleIds = await this.getEmployeeIdsByRoles(target.roles ?? []);

    const receiverIds = [
      ...new Set([...roleIds, ...(target.userIds ?? [])]),
    ].filter((id) => id && id !== payload.senderId);

    if (receiverIds.length === 0) return;

    // Gắn "nhân viên kinh doanh" (người tạo đề xuất) vào meta để FE có thể gom
    // nhóm thông báo theo nhân viên. Lỗi tra cứu không được làm hỏng việc gửi.
    let owner: {
      employeeId?: number;
      employeeName?: string;
      employeePhone?: string;
      suggestCode?: string;
    } = {};
    try {
      const suggest = await this.repo.findOne({
        where: { id: payload.suggestId },
        relations: ['createdByUser'],
      });
      if (suggest?.createdBy) {
        owner = {
          employeeId: suggest.createdBy,
          employeeName: suggest.createdByUser?.name
            ? fixVietnamese(suggest.createdByUser.name)
            : undefined,
          employeePhone: suggest.createdByUser?.phone,
          suggestCode: suggest.code ?? undefined,
        };
      }
    } catch (error) {
      this.logger.error('Resolve expense owner for notify failed', error as any);
    }

    // Thông báo đề xuất chi nằm chung trong phần "đề xuất" (type SUGGEST);
    // meta.suggestType giúp FE phân biệt & điều hướng đúng màn đề xuất chi.
    // meta.employeeId/employeeName = nhân viên kinh doanh sở hữu đề xuất.
    const meta = {
      suggestId: payload.suggestId,
      suggestType: SuggestType.EXPENSE_REQUEST,
      ...owner,
      ...payload.meta,
    };

    await this.notificationService.createNotifications({
      receiverIds,
      type: NotificationType.SUGGEST,
      entityId: payload.suggestId,
      message: payload.message,
      senderId: payload.senderId,
      meta,
    });

    try {
      const fcmTokens = await this.dataSource
        .getRepository(EmployeeFcmToken)
        .find({
          where: { employeeId: In(receiverIds) },
        });

      const tokens = [
        ...new Set(fcmTokens.map((t) => t.token).filter(Boolean)),
      ];

      if (tokens.length > 0) {
        await this.fcmService.sendToMultiple(
          tokens,
          payload.title,
          payload.message,
          {
            type: 'expense_request',
            id: String(payload.suggestId),
            url: `/expense-requests/${payload.suggestId}`,
          },
        );
      }
    } catch (error) {
      this.logger.error('FCM push (expense) failed', error as any);
    }
  }

  private async getEmployeeIdsByRoles(roles: string[]): Promise<number[]> {
    if (roles.length === 0) return [];

    const employees = await this.employeeRepo
      .createQueryBuilder('e')
      .select(['e.id'])
      .where(`e.roles && ARRAY[:...roles]::text[]`, { roles })
      .andWhere('e."isActive" = true')
      .getMany();

    return employees.map((e) => e.id).filter((id): id is number => !!id);
  }

  /**
   * Khung chung cho mọi bước chuyển trạng thái của đề xuất chi:
   * lock row → validate state machine → mutate → save → audit log.
   * Tất cả trong 1 transaction (atomic, chống double-submit).
   */
  private async expenseTransition(opts: {
    id: number;
    action: ExpenseAction;
    user: AuthUser;
    note?: string;
    mutate?: (s: Suggest) => void;
    extra?: (manager: EntityManager, s: Suggest) => Promise<void>;
  }): Promise<Suggest> {
    const user = this.ensureUser(opts.user);

    return this.dataSource.transaction(async (manager) => {
      const s = await manager.findOne(Suggest, {
        where: { id: opts.id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!s) {
        throw new NotFoundException('Đề xuất chi không tồn tại');
      }

      if (s.type !== SuggestType.EXPENSE_REQUEST) {
        throw new BadRequestException(
          'Đề xuất này không phải luồng đề xuất chi',
        );
      }

      const fromStatus = s.status as SuggestStatus;

      s.status = assertExpenseTransition(opts.action, fromStatus, {
        actorRoles: user.roles ?? [],
        kind: s.requestKind ?? ExpenseRequestKind.CASH,
        isOwner: s.createdBy === user.id,
        actorId: user.id,
        previousActorId: await this.lastExpenseActorId(manager, opts.id),
      });

      opts.mutate?.(s);

      const saved = await manager.save(s);

      if (opts.extra) {
        await opts.extra(manager, saved);
      }

      await this.writeExpenseLog(manager, {
        suggestId: saved.id!,
        userId: user.id,
        action: opts.action,
        fromStatus,
        toStatus: saved.status as SuggestStatus,
        note: opts.note ?? null,
      });

      // Bước vừa xong thì lời nhắc "đến lượt bạn" của những người CÙNG giữ
      // bước đó hết ý nghĩa — đánh dấu đã đọc cho cả nhóm, không chỉ người
      // vừa bấm. Đặt trong transition (chốt chung của MỌI bước) nên áp dụng
      // đồng loạt cho duyệt/từ chối, lên lệnh chi, xuất quỹ, hoàn quỹ...
      // Chạy TRƯỚC khi nơi gọi tạo thông báo cho bước kế tiếp, để không lỡ
      // tay đánh dấu luôn thông báo vừa tạo.
      await this.markExpenseStepNotificationsRead(saved, fromStatus, user);

      return saved;
    });
  }

  /**
   * Đánh dấu đã đọc thông báo của đúng nhóm vừa hoàn thành bước.
   *
   * Chỉ nhắm nhóm giữ bước `fromStatus` (theo `expenseActorForStatus`) chứ
   * không quét sạch mọi thông báo của đề xuất: các nhóm khác (người tạo đơn,
   * bộ phận ở bước sau) vẫn cần thấy thông báo kết quả của họ ở trạng thái
   * chưa đọc. Lỗi ở đây không được làm hỏng bước chuyển trạng thái.
   */
  private async markExpenseStepNotificationsRead(
    suggest: Suggest,
    fromStatus: SuggestStatus,
    actor: AuthUser,
  ) {
    try {
      const holder = expenseActorForStatus(fromStatus, suggest.requestKind);
      const receiverIds = [actor.id];

      if (holder?.owner && suggest.createdBy) {
        receiverIds.push(suggest.createdBy);
      }
      if (holder && !holder.owner) {
        receiverIds.push(...(await this.getEmployeeIdsByRoles(holder.roles)));
      }

      await this.notificationService.markAsReadByTypeEntityForReceivers(
        NotificationType.SUGGEST,
        suggest.id!,
        receiverIds,
      );
    } catch (error) {
      this.logger.error(
        'Đánh dấu đã đọc thông báo đề xuất chi lỗi',
        error as any,
      );
    }
  }

  // =========== BƯỚC 1.5 — SALES ADMIN kiểm duyệt (song song) ===========
  // Kiểm duyệt của Sales Admin KHÔNG chặn giám đốc: status vẫn giữ
  // PENDING_APPROVAL để giám đốc duyệt/từ chối bình thường. Nếu từ chối
  // chính sách thì lưu ghi chú và báo cho người tạo + giám đốc.

  async reviewExpenseBySaleAdmin(
    id: number,
    user: AuthUser,
    input: { status: 'REVIEWED' | 'REJECTED'; note?: string },
  ) {
    const actor = this.ensureUser(user);

    const note = input.note?.trim() || null;
    if (input.status === 'REJECTED' && !note) {
      throw new BadRequestException('Phải có ghi chú khi từ chối chính sách');
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const s = await manager.findOne(Suggest, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!s) {
        throw new NotFoundException('Đề xuất chi không tồn tại');
      }
      if (s.type !== SuggestType.EXPENSE_REQUEST) {
        throw new BadRequestException(
          'Đề xuất này không phải luồng đề xuất chi',
        );
      }
      // Chỉ kiểm duyệt khi đề xuất còn đang chờ giám đốc duyệt.
      if (s.status !== SuggestStatus.PENDING_APPROVAL) {
        throw new BadRequestException(
          'Chỉ kiểm duyệt khi đề xuất đang chờ giám đốc duyệt',
        );
      }

      // Kiểm duyệt chính sách là chốt kiểm soát, không phải việc của người đề
      // xuất — cùng nguyên tắc phân tách nhiệm vụ với `assertExpenseTransition`.
      // Bước này nằm ngoài state machine nên phải kiểm riêng ở đây.
      if (s.createdBy === actor.id) {
        throw new ForbiddenException(
          'Bạn là người tạo đề xuất này nên không được tự kiểm duyệt chính sách',
        );
      }

      // Cùng luật "hai chốt liên tiếp phải hai người" như trong state machine.
      if ((await this.lastExpenseActorId(manager, id)) === actor.id) {
        throw new ForbiddenException(
          'Bạn vừa thực hiện bước liền trước của đề xuất này nên không được kiểm duyệt tiếp. ' +
            'Hai bước kiểm soát liên tiếp phải do hai người khác nhau.',
        );
      }

      s.saleadminReviewStatus = input.status;
      s.saleadminNote = note;
      s.saleadminReviewedBy = actor.id;
      s.saleadminReviewedAt = new Date();

      const savedS = await manager.save(s);

      await this.writeExpenseLog(manager, {
        suggestId: savedS.id!,
        userId: actor.id,
        action:
          input.status === 'REJECTED'
            ? ExpenseAction.SALE_ADMIN_REJECT
            : ExpenseAction.SALE_ADMIN_REVIEW,
        // status không đổi — ghi cùng from/to để giữ nguyên audit
        fromStatus: SuggestStatus.PENDING_APPROVAL,
        toStatus: SuggestStatus.PENDING_APPROVAL,
        note,
      });

      return savedS;
    });

    // Kiểm duyệt chính sách là bước TRUNG GIAN: đề xuất vẫn chờ duyệt, giám
    // đốc/Sales Admin khác vẫn phải thấy "cần duyệt". Chỉ đánh dấu đã đọc cho
    // đúng người vừa kiểm duyệt.
    try {
      await this.notificationService.markAsReadByTypeEntityForReceiver(
        NotificationType.SUGGEST,
        saved.id!,
        actor.id,
      );
    } catch (error) {
      this.logger.error(
        'Đánh dấu đã đọc thông báo kiểm duyệt chính sách lỗi',
        error as any,
      );
    }

    // Báo cho người tạo đề xuất + giám đốc (không chặn giám đốc duyệt)
    const isReject = input.status === 'REJECTED';
    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: isReject
          ? '⚠️ Sales Admin từ chối chính sách'
          : '🔍 Sales Admin đã kiểm duyệt',
        message: isReject
          ? `Sales Admin đã từ chối chính sách đề xuất ${saved.code}: ${note}.` +
            ` Giám đốc vẫn có thể duyệt.`
          : `Sales Admin đã kiểm duyệt đề xuất ${saved.code}` +
            (note ? `: ${note}` : ''),
        senderId: actor.id,
        meta: {
          kind: isReject ? 'saleadmin_reject' : 'saleadmin_review',
          saleadminReviewStatus: input.status,
          saleadminNote: note,
        },
      },
      {
        roles: [ExpenseRole.DIRECTOR],
        userIds: saved.createdBy ? [saved.createdBy] : [],
      },
    );

    return this.findOneExpense(saved.id!);
  }

  // ======= BƯỚC 2 — DIRECTOR / SALES ADMIN duyệt / từ chối (ngang quyền) =======

  /**
   * Ai vừa chốt duyệt/từ chối — để thông báo nói đúng người, không mặc định
   * "giám đốc" nữa vì Sales Admin cũng duyệt được cùng chốt này.
   */
  private expenseApproverLabel(user: AuthUser) {
    return user.roles?.includes(ExpenseRole.DIRECTOR)
      ? 'giám đốc'
      : 'Sales Admin';
  }

  async approveExpense(id: number, user: AuthUser) {
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.APPROVE,
      user,
      mutate: (s) => {
        s.approvedBy = user.id;
        s.approvedAt = new Date();
        s.rejectReason = null;
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '✅ Đề xuất chi đã duyệt',
        message: `Đề xuất ${saved.code} đã được ${this.expenseApproverLabel(user)} duyệt`,
        senderId: user.id,
        meta: { status: saved.status },
      },
      {
        // Báo cả Giám đốc lẫn Sales Admin: hai người cùng giữ chốt duyệt này,
        // ai không phải người vừa chốt thì vẫn cần biết đề xuất đã được xử lý.
        roles: [
          ExpenseRole.TREASURER,
          ExpenseRole.SALES_ADMIN,
          ExpenseRole.DIRECTOR,
          ExpenseRole.DEBT_ACCOUNTANT,
        ],
        userIds: saved.createdBy ? [saved.createdBy] : [],
      },
    );

    return saved;
  }

  async rejectExpense(id: number, user: AuthUser, reason: string) {
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.REJECT,
      user,
      note: reason,
      mutate: (s) => {
        s.approvedBy = user.id;
        s.approvedAt = new Date();
        s.rejectReason = reason;
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '❌ Đề xuất chi bị từ chối',
        message: `Đề xuất ${saved.code} đã bị ${this.expenseApproverLabel(user)} từ chối: ${reason}`,
        senderId: user.id,
        meta: { status: saved.status, reason },
      },
      {
        // Người còn lại trong hai người giữ chốt duyệt vẫn cần biết kết quả.
        roles: [ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN],
        userIds: saved.createdBy ? [saved.createdBy] : [],
      },
    );

    return saved;
  }

  /**
   * Chủ đề xuất tự rút đơn khi chưa được duyệt.
   *
   * Cần action riêng vì `REJECT` đã cấm chủ đề xuất, nên sau khi siết phân tách
   * nhiệm vụ thì người tạo không còn cách nào tự huỷ đơn của mình.
   */
  async withdrawExpense(id: number, user: AuthUser, reason?: string) {
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.WITHDRAW,
      user,
      note: reason,
    });

    // Giám đốc rút hộ (overrideRoles) khác với chủ đơn tự rút — câu chữ và
    // người nhận thông báo phải phản ánh đúng ai vừa làm việc này.
    const withdrawnByOwner = saved.createdBy === user.id;

    // Báo cho những người đang chờ xử lý đơn này để họ khỏi mở ra rồi mới biết.
    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '↩️ Đề xuất chi đã được rút',
        message:
          (withdrawnByOwner
            ? `Đề xuất ${saved.code} đã được người tạo rút lại`
            : `Đề xuất ${saved.code} đã bị Giám đốc rút`) +
          (reason ? `: ${reason}` : ''),
        senderId: user.id,
        meta: { status: saved.status, reason: reason ?? null },
      },
      {
        roles: [ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN],
        // Chủ đơn không tự biết như khi chính họ rút — phải báo riêng cho họ.
        userIds: !withdrawnByOwner && saved.createdBy ? [saved.createdBy] : [],
      },
    );

    return saved;
  }

  /**
   * Chủ đề xuất (kinh doanh) sửa đề xuất đã gửi duyệt.
   *
   * Chỉ sửa được khi chưa phát sinh dòng tiền / xuất kho — tức còn ở
   * PENDING_APPROVAL hoặc APPROVED. Đề xuất đã duyệt mà sửa thì nội dung Giám
   * đốc đã chốt không còn đúng nữa, nên phải quay về PENDING_APPROVAL và xoá
   * dấu duyệt (kể cả kiểm duyệt của Sales Admin) để duyệt lại từ đầu.
   */
  async updateExpense(
    id: number,
    dto: UpdateExpenseRequestDto,
    fileUrl: string | undefined,
    user: AuthUser,
  ) {
    const actor = this.ensureUser(user);

    const EDITABLE_STATUSES: SuggestStatus[] = [
      SuggestStatus.PENDING_APPROVAL,
      SuggestStatus.APPROVED,
    ];

    const saved = await this.dataSource.transaction(async (manager) => {
      const suggest = await manager.findOne(Suggest, { where: { id } });

      if (!suggest || suggest.type !== SuggestType.EXPENSE_REQUEST) {
        throw new NotFoundException('Đề xuất chi không tồn tại');
      }
      if (suggest.createdBy !== actor.id) {
        throw new ForbiddenException('Chỉ người tạo mới được sửa đề xuất');
      }
      if (!suggest.status || !EDITABLE_STATUSES.includes(suggest.status)) {
        throw new ConflictException(
          'Chỉ sửa được đề xuất đang chờ duyệt hoặc đã duyệt nhưng chưa lên lệnh chi/xuất kho',
        );
      }

      // Gộp giá trị mới lên giá trị cũ rồi kiểm tra như lúc tạo — sửa xong
      // đề xuất vẫn phải là một đề xuất hợp lệ.
      const content = dto.content ?? suggest.content;
      const expectedPaymentDate =
        dto.expectedPaymentDate ?? suggest.expectedPaymentDate;
      if (!content?.trim()) {
        throw new BadRequestException('Thiếu tiêu đề/nội dung đề xuất');
      }
      if (!expectedPaymentDate) {
        throw new BadRequestException('Thiếu ngày dự kiến chi');
      }
      // Chỉ siết "từ hôm nay" khi người dùng thật sự đổi ngày — đề xuất cũ có
      // ngày đã qua vẫn phải sửa được các trường khác.
      if (dto.expectedPaymentDate && dto.expectedPaymentDate < vnToday()) {
        throw new BadRequestException(
          'Ngày dự kiến chi phải từ hôm nay trở đi',
        );
      }

      // Đổi trường ⇄ xã/phường: gửi cái nào thì chuyển sang cái đó, cái kia xoá.
      const changesSchool = dto.schoolId !== undefined && dto.schoolId !== null;
      const changesWard = dto.wardId !== undefined && dto.wardId !== null;
      let schoolId = suggest.schoolId ?? null;
      let schoolYear = dto.schoolYear ?? suggest.schoolYear ?? null;
      let wardId = suggest.wardId ?? null;

      if (changesSchool) {
        schoolId = dto.schoolId!;
        wardId = null;
      } else if (changesWard) {
        wardId = dto.wardId!;
        schoolId = null;
        schoolYear = null;
      }

      if (schoolId) {
        const school = await manager.findOne(School, { where: { id: schoolId } });
        if (!school) throw new BadRequestException('Trường không tồn tại');
        if (!schoolYear) throw new BadRequestException('Thiếu năm học');
        if (!this.isValidSchoolYear(schoolYear)) {
          throw new BadRequestException('Năm học không hợp lệ');
        }
        const subjectCount = await manager.count(Subject, {
          where: { schoolId, schoolYear },
        });
        if (subjectCount === 0) {
          throw new BadRequestException(
            'Trường không có môn học trong năm học đã chọn',
          );
        }
      } else if (wardId) {
        const ward = await manager.findOne(Ward, { where: { id: wardId } });
        if (!ward) throw new BadRequestException('Xã/phường không tồn tại');
      } else {
        throw new BadRequestException('Thiếu xã/phường');
      }

      const fromStatus = suggest.status;
      const needsReapproval = fromStatus === SuggestStatus.APPROVED;

      suggest.content = content;
      if (dto.description !== undefined) suggest.description = dto.description;
      if (dto.participants !== undefined) suggest.participants = dto.participants;
      if (dto.beneficiaryInfo !== undefined) {
        suggest.beneficiaryInfo = dto.beneficiaryInfo;
      }
      suggest.expectedPaymentDate = expectedPaymentDate;
      suggest.schoolId = schoolId;
      suggest.schoolYear = schoolYear;
      suggest.wardId = wardId;
      if (fileUrl) suggest.fileUrl = fileUrl;
      suggest.version = (suggest.version ?? 1) + 1;

      if (needsReapproval) {
        suggest.status = SuggestStatus.PENDING_APPROVAL;
        suggest.approvedBy = undefined;
        suggest.approvedAt = null;
        suggest.rejectReason = null;
        suggest.saleadminReviewStatus = null;
        suggest.saleadminNote = null;
        suggest.saleadminReviewedBy = null;
        suggest.saleadminReviewedAt = null;
      }

      const s = await manager.save(suggest);

      if (fileUrl) {
        await this.saveExpenseAttachments(
          manager,
          s.id!,
          [{ fileUrl, fileName: fileUrl.split('/').pop() || 'file' }],
          actor.id,
        );
      }

      await this.writeExpenseLog(manager, {
        suggestId: s.id!,
        userId: actor.id,
        action: ExpenseAction.UPDATE,
        fromStatus,
        toStatus: s.status,
        note: needsReapproval ? 'Sửa sau khi đã duyệt — cần duyệt lại' : null,
      });

      return { s, needsReapproval };
    });

    await this.notifyExpense(
      {
        suggestId: saved.s.id!,
        title: saved.needsReapproval
          ? '🔁 Đề xuất chi cần duyệt lại'
          : '✏️ Đề xuất chi đã được sửa',
        message: saved.needsReapproval
          ? `Đề xuất ${saved.s.code} đã được sửa sau khi duyệt, cần duyệt lại: ${saved.s.content}`
          : `Đề xuất ${saved.s.code} đang chờ duyệt vừa được sửa: ${saved.s.content}`,
        senderId: actor.id,
        meta: { status: saved.s.status, reapproval: saved.needsReapproval },
      },
      { roles: [ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN] },
    );

    return this.findOneExpense(saved.s.id!);
  }

  /**
   * Giám đốc xoá hẳn một đề xuất chi. Khác `withdrawExpense` (chuyển trạng
   * thái, giữ lại audit trail): đây là xoá cứng khỏi DB, chỉ cho phép khi
   * tiền chưa phát sinh (chưa lên lệnh chi/xuất quỹ) để không phá vỡ lịch sử
   * dòng tiền đã thực hiện.
   */
  async deleteExpense(id: number, user: AuthUser) {
    const suggest = await this.repo.findOne({ where: { id } });

    if (!suggest) {
      throw new NotFoundException('Đề xuất chi không tồn tại');
    }

    if (suggest.type !== SuggestType.EXPENSE_REQUEST) {
      throw new BadRequestException('Đề xuất này không phải luồng đề xuất chi');
    }

    // Đã phát sinh dòng tiền (nhánh tiền) hoặc đã xuất kho (nhánh thiết bị)
    // thì không xoá được — lịch sử tiền/hàng đã thực hiện phải giữ nguyên.
    const RESOURCE_MOVED_STATUSES: SuggestStatus[] = [
      SuggestStatus.PAYMENT_ORDERED,
      SuggestStatus.CASH_RELEASED,
      SuggestStatus.CASH_RECEIVED,
      SuggestStatus.SPENT,
      SuggestStatus.NOT_SPENT,
      SuggestStatus.FUND_RETURNED,
      SuggestStatus.STOCK_ISSUE_ORDERED,
      SuggestStatus.EQUIPMENT_RECEIVED,
      SuggestStatus.EQUIPMENT_RETURNED,
    ];

    if (suggest.status && RESOURCE_MOVED_STATUSES.includes(suggest.status)) {
      throw new BadRequestException(
        'Không thể xoá đề xuất đã phát sinh dòng tiền/xuất kho ' +
          '(đã lên lệnh chi, xuất quỹ hoặc lên lệnh xuất kho)',
      );
    }

    const { code, createdBy, status } = suggest;

    // Báo cho người tạo trước khi xoá — sau khi xoá, `notifyExpense` sẽ không
    // còn tra được thông tin đề xuất để gắn vào meta.
    if (createdBy && createdBy !== user.id) {
      await this.notifyExpense(
        {
          suggestId: id,
          title: '🗑️ Đề xuất chi đã bị xoá',
          message: `Đề xuất ${code} đã bị Giám đốc xoá`,
          senderId: user.id,
          meta: { status },
        },
        { userIds: [createdBy] },
      );
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(SuggestHistory, { suggestId: id });
      await manager.remove(Suggest, suggest);
    });

    return { message: 'Đã xoá đề xuất chi' };
  }

  // ================= BƯỚC 3 — KẾ TOÁN CÔNG NỢ lên lệnh chi =================

  async createExpensePaymentOrder(
    id: number,
    dto: CreatePaymentOrderDto,
    user: AuthUser,
  ) {
    let paymentOrder: SuggestPaymentOrder | null = null;

    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CREATE_PAYMENT_ORDER,
      user,
      note: dto.note,
      mutate: (s) => {
        // Một đề xuất có thể được chi lại sau khi đã hoàn quỹ.
        // Xóa dấu vết trạng thái của vòng chi trước trước khi mở vòng mới.
        s.cashReleasedBy = null;
        s.cashReleasedAt = null;
        s.cashReceivedAt = null;
        s.spentAt = null;
        s.notSpentReason = null;
        s.fundReturnedBy = null;
        s.fundReturnedAt = null;
      },
      extra: async (manager, s) => {
        const code = await this.generateCode(
          manager,
          'suggest_payment_order',
          'code',
          'LC',
        );

        // Quan hệ hiện tại là 1-1: thay lệnh chi của vòng đã hoàn quỹ
        // bằng lệnh mới, còn lịch sử chuyển trạng thái vẫn được giữ.
        await manager.delete(SuggestPaymentOrder, {
          suggestId: s.id!,
        });

        paymentOrder = await manager.save(SuggestPaymentOrder, {
          code,
          suggestId: s.id!,
          amount: dto.amount,
          paymentMethod: dto.paymentMethod,
          note: dto.note ?? null,
          createdBy: user.id,
        });
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '🧾 Lệnh chi mới',
        message:
          `Lệnh chi ${(paymentOrder as SuggestPaymentOrder | null)?.code} đã được lập` +
          ` cho đề xuất ${saved.code}, vui lòng xuất tiền và chọn nguồn tiền`,
        senderId: user.id,
        meta: {
          status: saved.status,
          paymentOrderId: (paymentOrder as SuggestPaymentOrder | null)?.id,
        },
      },
      { roles: [ExpenseRole.TREASURER] },
    );

    return { suggest: saved, paymentOrder };
  }

  // ================= BƯỚC 4 — THỦ QUỸ xác nhận đã xuất tiền =================

  async confirmCashReleased(
    id: number,
    user: AuthUser,
    note?: string,
    files?: UploadedAttachment[],
    fundSource?: FundSource,
  ) {
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_CASH_RELEASED,
      user,
      note,
      mutate: (s) => {
        s.cashReleasedBy = user.id;
        s.cashReleasedAt = new Date();
      },
      extra: async (manager, s) => {
        await this.saveExpenseAttachments(manager, s.id!, files, user.id);
        if (fundSource) {
          await manager.update(
            SuggestPaymentOrder,
            { suggestId: s.id! },
            { fundSource },
          );
        }
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '💵 Thủ quỹ đã xuất tiền',
        message:
          `Thủ quỹ đã xuất tiền cho đề xuất ${saved.code}` +
          (fundSource
            ? ` từ ${FUND_SOURCE_LABEL[fundSource]},`
            : ',') +
          ` vui lòng xác nhận nhận tiền`,
        senderId: user.id,
        meta: { status: saved.status, fundSource: fundSource ?? null },
      },
      { userIds: saved.createdBy ? [saved.createdBy] : [] },
    );

    return saved;
  }

  // ================= BƯỚC 5 — SALES xác nhận đã nhận tiền =================

  async confirmCashReceived(id: number, user: AuthUser, note?: string) {
    return this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_CASH_RECEIVED,
      user,
      note,
      mutate: (s) => {
        s.cashReceivedAt = new Date();
      },
    });
  }

  // ================= BƯỚC 6A — SALES xác nhận đã chi =================

  async confirmSpent(
    id: number,
    user: AuthUser,
    note?: string,
    files?: UploadedAttachment[],
  ) {
    return this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_SPENT,
      user,
      note,
      mutate: (s) => {
        s.spentAt = new Date();
      },
      extra: async (manager, s) => {
        await this.saveExpenseAttachments(manager, s.id!, files, user.id);
      },
    });
  }

  // ================= BƯỚC 6B — SALES xác nhận chưa chi =================

  async confirmNotSpent(id: number, user: AuthUser, reason: string) {
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_NOT_SPENT,
      user,
      note: reason,
      mutate: (s) => {
        s.notSpentReason = reason;
      },
    });

    const isEquipment = saved.requestKind === ExpenseRequestKind.EQUIPMENT;

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: isEquipment ? '↩️ Nhập lại kho thiết bị' : '↩️ Hoàn tiền về quỹ',
        message: isEquipment
          ? `Kinh doanh chưa dùng thiết bị của đề xuất ${saved.code}, sẽ trả lại kho,` +
            ` vui lòng xác nhận khi nhận lại`
          : `Kinh doanh chưa chi đề xuất ${saved.code}, sẽ hoàn tiền về quỹ,` +
            ` vui lòng xác nhận khi nhận lại`,
        senderId: user.id,
        meta: { status: saved.status, reason },
      },
      {
        roles: [isEquipment ? ExpenseRole.TECHNICAL : ExpenseRole.TREASURER],
      },
    );

    return saved;
  }

  // ================= BƯỚC 7 — THỦ QUỸ xác nhận đã nhận lại quỹ =================

  async confirmFundReturned(id: number, user: AuthUser, note?: string) {
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_FUND_RETURNED,
      user,
      note,
      mutate: (s) => {
        s.fundReturnedBy = user.id;
        s.fundReturnedAt = new Date();
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '↩️ Đã hoàn quỹ',
        message:
          `Đề xuất ${saved.code} đã hoàn quỹ,` +
          ` kế toán công nợ có thể lập lại lệnh chi`,
        senderId: user.id,
        meta: { status: saved.status },
      },
      { roles: [ExpenseRole.DEBT_ACCOUNTANT] },
    );

    return saved;
  }


  // ============================================================
  // ===== Nhánh ĐỀ XUẤT THIẾT BỊ — phòng kỹ thuật & kho =====
  // ============================================================

  /** BƯỚC 3' — PHÒNG KỸ THUẬT lên lệnh xuất kho */
  async createExpenseStockIssueOrder(
    id: number,
    dto: CreateStockIssueOrderDto,
    user: AuthUser,
  ) {
    let stockIssueOrder: SuggestStockIssueOrder | null = null;

    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CREATE_STOCK_ISSUE_ORDER,
      user,
      note: dto.note,
      mutate: (s) => {
        // Thiết bị có thể được xuất lại sau khi đã nhập kho trở lại — xoá dấu
        // vết của vòng trước, giống `createExpensePaymentOrder` ở nhánh tiền.
        s.equipmentReceivedAt = null;
        s.spentAt = null;
        s.notSpentReason = null;
        s.equipmentReturnedBy = null;
        s.equipmentReturnedAt = null;
      },
      extra: async (manager, s) => {
        const code = await this.generateCode(
          manager,
          'suggest_stock_issue_order',
          'code',
          'XK',
        );

        // Quan hệ 1-1: lệnh xuất kho mới thay lệnh của vòng đã nhập lại kho,
        // lịch sử chuyển trạng thái vẫn giữ nguyên.
        await manager.delete(SuggestStockIssueOrder, { suggestId: s.id! });

        stockIssueOrder = await manager.save(SuggestStockIssueOrder, {
          code,
          suggestId: s.id!,
          items: dto.items,
          warehouse: dto.warehouse ?? null,
          expectedDeliveryDate: dto.expectedDeliveryDate ?? null,
          note: dto.note ?? null,
          createdBy: user.id,
        });

        // Thiết bị chọn từ kho có sẵn (`warehouseItemId`) sẽ tự trừ tồn ngay
        // khi lệnh xuất kho được lập.
        const warehouseLines = dto.items
          .filter((it) => it.warehouseItemId != null)
          .map((it) => ({
            warehouseItemId: it.warehouseItemId!,
            quantity: it.quantity,
          }));

        if (warehouseLines.length > 0) {
          await this.warehouseService.exportForSuggestWithManager(
            manager,
            warehouseLines,
            user.id,
            s.id!,
          );
        }
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '📦 Lệnh xuất kho mới',
        message:
          `Lệnh xuất kho ${(stockIssueOrder as SuggestStockIssueOrder | null)?.code} đã được lập` +
          ` cho đề xuất ${saved.code}, vui lòng xác nhận khi nhận thiết bị`,
        senderId: user.id,
        meta: {
          status: saved.status,
          stockIssueOrderId: (stockIssueOrder as SuggestStockIssueOrder | null)
            ?.id,
        },
      },
      { userIds: saved.createdBy ? [saved.createdBy] : [] },
    );

    return { suggest: saved, stockIssueOrder };
  }

  /** BƯỚC 4' — SALES xác nhận đã nhận thiết bị */
  async confirmEquipmentReceived(id: number, user: AuthUser, note?: string) {
    return this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_EQUIPMENT_RECEIVED,
      user,
      note,
      mutate: (s) => {
        s.equipmentReceivedAt = new Date();
      },
    });
  }

  /** BƯỚC 5' — PHÒNG KỸ THUẬT xác nhận đã nhận lại thiết bị chưa dùng */
  async confirmEquipmentReturned(id: number, user: AuthUser, note?: string) {
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_EQUIPMENT_RETURNED,
      user,
      note,
      mutate: (s) => {
        s.equipmentReturnedBy = user.id;
        s.equipmentReturnedAt = new Date();
      },
      extra: async (manager, s) => {
        // Thiết bị đã xuất từ kho có sẵn (`warehouseItemId`) được nhập lại
        // kho khi kinh doanh trả lại, để phòng kỹ thuật lập lại lệnh xuất kho
        // từ đúng số tồn.
        const order = await manager.findOne(SuggestStockIssueOrder, {
          where: { suggestId: s.id! },
        });
        const lines = (order?.items ?? [])
          .filter((it) => it.warehouseItemId != null)
          .map((it) => ({
            warehouseItemId: it.warehouseItemId!,
            quantity: it.quantity,
          }));

        if (lines.length > 0) {
          await this.warehouseService.importForSuggestWithManager(
            manager,
            lines,
            user.id,
            s.id!,
          );
        }
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '📦 Thiết bị đã nhập lại kho',
        message:
          `Thiết bị của đề xuất ${saved.code} đã nhập lại kho,` +
          ` phòng kỹ thuật có thể lập lại lệnh xuất kho`,
        senderId: user.id,
        meta: { status: saved.status },
      },
      { roles: [ExpenseRole.TECHNICAL] },
    );

    return saved;
  }

  // ================= QUERY =================

  /** Áp các bộ lọc chung của đề xuất chi lên query builder (alias 's'). */
  private applyExpenseFilters(
    qb: SelectQueryBuilder<Suggest>,
    filter: FilterExpenseDto,
  ) {
    const {
      status,
      requestKind,
      createdBy,
      schoolId,
      schoolYear,
      fromDate,
      toDate,
      overdue,
    } = filter;

    if (status) qb.andWhere('s.status = :status', { status });
    if (requestKind)
      qb.andWhere('s.requestKind = :requestKind', { requestKind });
    if (createdBy) qb.andWhere('s.createdBy = :createdBy', { createdBy });
    if (schoolId !== undefined && schoolId !== null)
      qb.andWhere('s.schoolId = :schoolId', { schoolId });
    if (schoolYear) qb.andWhere('s.schoolYear = :schoolYear', { schoolYear });
    if (fromDate)
      qb.andWhere('s.expectedPaymentDate >= :fromDate', { fromDate });
    if (toDate) qb.andWhere('s.expectedPaymentDate <= :toDate', { toDate });
    if (overdue !== undefined)
      qb.andWhere('s.isOverdue = :overdue', { overdue });

    return qb;
  }

  /**
   * Phòng kỹ thuật chỉ phụ trách nhánh THIẾT BỊ — nếu tài khoản chỉ có role
   * `ky_thuat` (không kiêm role nào khác của luồng đề xuất chi) thì mọi truy
   * vấn đều bị ép về `requestKind = EQUIPMENT`, không xem được đề xuất tiền.
   */
  private isTechnicalOnly(actor?: AuthUser): boolean {
    const roles = actor?.roles ?? [];
    if (!roles.includes(ExpenseRole.TECHNICAL)) return false;
    const otherExpenseRoles: string[] = [
      ExpenseRole.SALES,
      ExpenseRole.DIRECTOR,
      ExpenseRole.DEBT_ACCOUNTANT,
      ExpenseRole.TREASURER,
      ExpenseRole.SALES_ADMIN,
    ];
    return !roles.some((r) => otherExpenseRoles.includes(r));
  }

  /** Ép bộ lọc theo phạm vi role của người gọi. */
  private scopeExpenseFilter(
    filter: FilterExpenseDto,
    actor?: AuthUser,
  ): FilterExpenseDto {
    if (this.isTechnicalOnly(actor)) {
      return { ...filter, requestKind: ExpenseRequestKind.EQUIPMENT };
    }
    return filter;
  }

  async findAllExpense(rawFilter: FilterExpenseDto, actor?: AuthUser) {
    const filter = this.scopeExpenseFilter(rawFilter, actor);
    const { page = 1, limit = 20 } = filter;

    const qb = this.repo
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.createdByUser', 'creator')
      .leftJoinAndSelect('s.paymentOrder', 'po')
      .leftJoinAndSelect('s.stockIssueOrder', 'sio')
      .leftJoinAndSelect('s.school', 'school')
      .where('s.type = :type', { type: SuggestType.EXPENSE_REQUEST });

    this.applyExpenseFilters(qb, filter);

    const [data, total] = await qb
      .orderBy('s.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Danh sách đề xuất chi GOM NHÓM THEO NHÂN VIÊN (người tạo).
   * Phân trang theo nhân viên: mỗi trang là `limit` nhân viên, kèm toàn bộ
   * đề xuất của họ + tổng số & tổng tiền. Dùng chung bộ lọc của findAllExpense.
   */
  async findAllExpenseGroupedByEmployee(
    rawFilter: FilterExpenseDto,
    actor?: AuthUser,
  ) {
    const filter = this.scopeExpenseFilter(rawFilter, actor);
    const { page = 1, limit = 20 } = filter;

    // Bước 1: tổng hợp theo nhân viên, sắp xếp theo đề xuất gần nhất
    const groupQb = this.repo
      .createQueryBuilder('s')
      .select('s.createdBy', 'employeeId')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(s.amount), 0)', 'totalAmount')
      .addSelect('MAX(s.createdAt)', 'lastCreatedAt')
      .where('s.type = :type', { type: SuggestType.EXPENSE_REQUEST })
      .andWhere('s.createdBy IS NOT NULL');

    this.applyExpenseFilters(groupQb, filter);

    const groupsRaw = await groupQb
      .groupBy('s.createdBy')
      .orderBy('MAX(s.createdAt)', 'DESC')
      .getRawMany();

    const total = groupsRaw.length; // tổng số nhân viên
    const pageGroups = groupsRaw.slice((page - 1) * limit, page * limit);
    const employeeIds = pageGroups
      .map((g) => Number(g.employeeId))
      .filter((id): id is number => !!id);

    if (employeeIds.length === 0) {
      return {
        data: [],
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    }

    // Bước 2: lấy đề xuất của các nhân viên trong trang (cùng bộ lọc)
    const itemsQb = this.repo
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.paymentOrder', 'po')
      .leftJoinAndSelect('s.stockIssueOrder', 'sio')
      .leftJoinAndSelect('s.school', 'school')
      .where('s.type = :type', { type: SuggestType.EXPENSE_REQUEST })
      .andWhere('s.createdBy IN (:...employeeIds)', { employeeIds });

    this.applyExpenseFilters(itemsQb, filter);

    const items = await itemsQb.orderBy('s.createdAt', 'DESC').getMany();

    // Thông tin nhân viên (chỉ id/name/phone — không lộ password)
    const employees = await this.dataSource.getRepository(Employee).find({
      where: { id: In(employeeIds) },
      select: { id: true, name: true, phone: true },
    });
    const employeeById = new Map(employees.map((e) => [e.id, e]));

    const requestsByEmployee = new Map<number, Suggest[]>();
    for (const s of items) {
      const key = s.createdBy!;
      if (!requestsByEmployee.has(key)) requestsByEmployee.set(key, []);
      requestsByEmployee.get(key)!.push(s);
    }

    // Bước 3: dựng nhóm theo đúng thứ tự đã phân trang
    const data = pageGroups.map((g) => {
      const employeeId = Number(g.employeeId);
      const emp = employeeById.get(employeeId);
      return {
        employeeId,
        employee: emp
          ? { id: emp.id, name: emp.name, phone: emp.phone ?? null }
          : null,
        total: Number(g.count),
        totalAmount: Number(g.totalAmount),
        requests: requestsByEmployee.get(employeeId) ?? [],
      };
    });

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** Chi tiết đề xuất chi + logs + payment order + attachments */
  async findOneExpense(id: number, actor?: AuthUser) {
    const s = await this.repo.findOne({
      where: { id, type: SuggestType.EXPENSE_REQUEST },
      relations: {
        createdByUser: true,
        paymentOrder: { creator: true },
        stockIssueOrder: { creator: true },
        attachments: true,
        school: true,
      },
    });

    if (!s) {
      throw new NotFoundException('Đề xuất chi không tồn tại');
    }

    if (
      this.isTechnicalOnly(actor) &&
      s.requestKind !== ExpenseRequestKind.EQUIPMENT
    ) {
      throw new ForbiddenException(
        'Phòng kỹ thuật chỉ xem được đề xuất thiết bị',
      );
    }

    const logs = await this.historyRepo.find({
      where: { suggestId: id },
      order: { snapshotAt: 'ASC' },
    });

    const actorIds = [...new Set(logs.map((l) => l.userId).filter(Boolean))];
    const actors = actorIds.length
      ? await this.employeeRepo.findBy({ id: In(actorIds) })
      : [];
    const actorNameById = new Map(actors.map((a) => [a.id, a.name]));
    const enrichedLogs = logs.map((l) => ({
      ...l,
      actorName: l.userId ? actorNameById.get(l.userId) : undefined,
    }));

    return { ...s, logs: enrichedLogs };
  }

  /**
   * "Việc cần làm của tôi" cho luồng đề xuất chi — theo role hiện tại:
   * - director:       PENDING_APPROVAL
   * - saleadmin:      PENDING_APPROVAL (chưa kiểm duyệt)
   * - ketoan_congno:  APPROVED, FUND_RETURNED
   * - thuquy:         PAYMENT_ORDERED, NOT_SPENT (đề xuất tiền)
   * - ky_thuat:       APPROVED, NOT_SPENT, EQUIPMENT_RETURNED (đề xuất thiết bị)
   * - sales (chủ):    DRAFT, CASH_RELEASED, CASH_RECEIVED,
   *                   STOCK_ISSUE_ORDERED, EQUIPMENT_RECEIVED
   */
  async myExpenseTasks(user: AuthUser) {
    const actor = this.ensureUser(user);
    const roles = actor.roles ?? [];

    const qb = this.repo
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.createdByUser', 'creator')
      .leftJoinAndSelect('s.paymentOrder', 'po')
      .leftJoinAndSelect('s.stockIssueOrder', 'sio')
      .leftJoinAndSelect('s.school', 'school')
      .where('s.type = :type', { type: SuggestType.EXPENSE_REQUEST });

    const conditions: string[] = [];
    const params: Record<string, any> = {};
    params.meId = actor.id;

    /**
     * Các bước kiểm soát đều cấm chính người tạo đề xuất
     * (`assertExpenseTransition`), nên phải loại đề xuất của chính mình khỏi
     * danh sách việc cần làm. Không loại thì người kiêm nhiệm — ví dụ vừa
     * `sales` vừa `thuquy` — thấy đề xuất của chính mình nằm trong danh sách,
     * bấm vào rồi nhận 403.
     */
    const notMine = (condition: string) => `(s.createdBy != :meId AND ${condition})`;

    if (roles.includes(ExpenseRole.DIRECTOR)) {
      conditions.push(notMine('s.status = :dirStatus'));
      params.dirStatus = SuggestStatus.PENDING_APPROVAL;
    }
    if (roles.includes(ExpenseRole.SALES_ADMIN)) {
      // Sales Admin giờ duyệt/từ chối được ngang quyền Giám đốc nên vẫn còn
      // việc kể cả khi đã kiểm duyệt chính sách xong — không lọc theo
      // `saleadminReviewStatus` nữa.
      conditions.push(notMine('s.status = :saStatus'));
      params.saStatus = SuggestStatus.PENDING_APPROVAL;
    }
    // Kế toán & thủ quỹ chỉ giữ nhánh tiền, phòng kỹ thuật chỉ giữ nhánh
    // thiết bị. `APPROVED` và `NOT_SPENT` dùng chung cho cả hai nhánh nên
    // phải lọc thêm theo `requestKind`, không thì kế toán thấy cả đề xuất
    // thiết bị rồi bấm vào nhận 409.
    params.cashKind = ExpenseRequestKind.CASH;
    params.equipmentKind = ExpenseRequestKind.EQUIPMENT;

    if (roles.includes(ExpenseRole.DEBT_ACCOUNTANT)) {
      conditions.push(
        notMine(
          's.requestKind = :cashKind AND s.status IN (:...accStatuses)',
        ),
      );
      params.accStatuses = [
        SuggestStatus.APPROVED,
        SuggestStatus.FUND_RETURNED,
      ];
    }
    if (roles.includes(ExpenseRole.TREASURER)) {
      conditions.push(
        notMine(
          's.requestKind = :cashKind AND s.status IN (:...treStatuses)',
        ),
      );
      params.treStatuses = [
        SuggestStatus.PAYMENT_ORDERED,
        SuggestStatus.NOT_SPENT,
      ];
    }
    if (roles.includes(ExpenseRole.TECHNICAL)) {
      conditions.push(
        notMine(
          's.requestKind = :equipmentKind AND s.status IN (:...techStatuses)',
        ),
      );
      params.techStatuses = [
        SuggestStatus.APPROVED,
        SuggestStatus.EQUIPMENT_RETURNED,
        SuggestStatus.NOT_SPENT,
      ];
    }
    if (roles.includes(ExpenseRole.SALES)) {
      conditions.push(
        '(s.createdBy = :meId AND s.status IN (:...saleStatuses))',
      );
      params.saleStatuses = [
        SuggestStatus.CASH_RELEASED,
        SuggestStatus.CASH_RECEIVED,
        SuggestStatus.STOCK_ISSUE_ORDERED,
        SuggestStatus.EQUIPMENT_RECEIVED,
      ];
    }

    if (conditions.length === 0) return [];

    return qb
      .andWhere(`(${conditions.join(' OR ')})`, params)
      .orderBy('s.isOverdue', 'DESC')
      .addOrderBy('s.expectedPaymentDate', 'ASC')
      .getMany();
  }

  // ================= REMINDER SETTINGS =================

  async getRemindBeforeDays(): Promise<number> {
    const setting = await this.settingRepo.findOne({
      where: { key: REMIND_BEFORE_DAYS_KEY },
    });
    const parsed = setting ? parseInt(setting.value, 10) : NaN;
    return Number.isNaN(parsed) ? DEFAULT_REMIND_BEFORE_DAYS : parsed;
  }

  async updateRemindBeforeDays(days: number) {
    await this.settingRepo.upsert(
      { key: REMIND_BEFORE_DAYS_KEY, value: String(days) },
      ['key'],
    );
    return { remindBeforeDays: days };
  }

  async getExpenseRemindersEnabled(): Promise<boolean> {
    const setting = await this.settingRepo.findOne({
      where: { key: EXPENSE_REMINDERS_ENABLED_KEY },
    });
    if (!setting) return DEFAULT_EXPENSE_REMINDERS_ENABLED;
    return setting.value === 'true';
  }

  async getExpenseReminderSettings() {
    const [remindBeforeDays, enabled] = await Promise.all([
      this.getRemindBeforeDays(),
      this.getExpenseRemindersEnabled(),
    ]);
    return { remindBeforeDays, enabled };
  }

  async updateExpenseReminderSettings(settings: {
    remindBeforeDays?: number;
    enabled?: boolean;
  }) {
    const rows: Array<Pick<SuggestReminderSetting, 'key' | 'value'>> = [];
    if (settings.remindBeforeDays !== undefined) {
      rows.push({
        key: REMIND_BEFORE_DAYS_KEY,
        value: String(settings.remindBeforeDays),
      });
    }
    if (settings.enabled !== undefined) {
      rows.push({
        key: EXPENSE_REMINDERS_ENABLED_KEY,
        value: String(settings.enabled),
      });
    }
    if (rows.length) await this.settingRepo.upsert(rows, ['key']);
    return this.getExpenseReminderSettings();
  }

  private isValidSchoolYear(schoolYear: string): boolean {
    const match = /^(\d{4})-(\d{4})$/.exec(schoolYear);
    if (!match) return false;

    return Number(match[2]) === Number(match[1]) + 1;
  }

  // ================= CRON BÁO ĐỘNG (08:00 giờ VN) =================

  @Cron('0 8 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleExpenseReminders() {
    // dev (sales-be) và prod chạy chung DB, mỗi process tự đăng ký cron
    // riêng — không chặn thì nhắc bị gửi trùng mỗi ngày. Xem is-cron-leader.ts.
    if (!isCronLeader()) return;
    try {
      const result = await this.runExpenseReminders();
      this.logger.log(
        `Expense reminders: upcoming=${result.upcoming}, ` +
          `dueToday=${result.dueToday}, overdue=${result.overdue}`,
      );
    } catch (error) {
      this.logger.error('Expense reminder job failed', error as any);
    }
  }

  async runExpenseReminders() {
    const enabled = await this.getExpenseRemindersEnabled();
    if (!enabled) {
      return { enabled: false, upcoming: 0, dueToday: 0, overdue: 0 };
    }

    const today = vnToday();
    const remindBeforeDays = await this.getRemindBeforeDays();

    const requests = await this.repo.find({
      where: {
        type: SuggestType.EXPENSE_REQUEST,
        status: Not(In(EXPENSE_TERMINAL_STATUSES)),
      },
    });

    const counters = { upcoming: 0, dueToday: 0, overdue: 0 };

    for (const s of requests) {
      if (!s.expectedPaymentDate) continue;

      const d = diffDays(s.expectedPaymentDate, today);

      if (d > 0 && d <= remindBeforeDays) {
        counters.upcoming += await this.remindUpcoming(s, d);
      } else if (d === 0) {
        counters.dueToday += await this.remindDueToday(s);
      } else if (d < 0) {
        counters.overdue += await this.remindOverdue(s, -d);
      }
    }

    return { enabled: true, ...counters };
  }

  private async remindUpcoming(s: Suggest, daysLeft: number) {
    let roles: string[] = [];
    let message = '';

    if (s.status === SuggestStatus.PENDING_APPROVAL) {
      roles = [ExpenseRole.DIRECTOR];
      message =
        `Đề xuất ${s.code} dự kiến chi trong ${daysLeft} ngày` +
        ` (${s.expectedPaymentDate}) nhưng chưa được duyệt`;
    } else if (s.status === SuggestStatus.APPROVED) {
      // Đã duyệt nhưng chưa sang bước kế: đề xuất tiền chờ kế toán lên lệnh
      // chi, đề xuất thiết bị chờ kỹ thuật lên lệnh xuất kho.
      const isEquipment = s.requestKind === ExpenseRequestKind.EQUIPMENT;
      roles = [
        isEquipment ? ExpenseRole.TECHNICAL : ExpenseRole.DEBT_ACCOUNTANT,
      ];
      message =
        `Đề xuất ${s.code} dự kiến ${isEquipment ? 'giao thiết bị' : 'chi'} trong ${daysLeft} ngày` +
        ` (${s.expectedPaymentDate}) nhưng chưa lên ${isEquipment ? 'lệnh xuất kho' : 'lệnh chi'}`;
    } else {
      return 0;
    }

    await this.notifyExpense(
      {
        suggestId: s.id!,
        title: '⏰ Sắp đến ngày chi',
        message,
        meta: { kind: 'reminder', status: s.status },
      },
      { roles },
    );

    return 1;
  }

  private async remindDueToday(s: Suggest) {
    const actor = expenseActorForStatus(
      s.status as SuggestStatus,
      s.requestKind,
    );
    if (!actor) return 0;

    await this.notifyExpense(
      {
        suggestId: s.id!,
        title: '📅 Hôm nay là ngày dự kiến chi',
        message:
          `Hôm nay là ngày dự kiến chi của đề xuất ${s.code}` +
          ` (đang ở bước ${s.status})`,
        meta: { kind: 'due_today', status: s.status },
      },
      {
        roles: [...(actor.owner ? [] : actor.roles), ExpenseRole.DIRECTOR],
        userIds: actor.owner && s.createdBy ? [s.createdBy] : [],
      },
    );

    return 1;
  }

  private async remindOverdue(s: Suggest, daysLate: number) {
    if (!s.isOverdue) {
      await this.repo.update(s.id!, { isOverdue: true });
    }

    // Đã tắt nhắc riêng cho đề xuất này — vẫn đánh dấu quá hạn ở trên để các
    // màn khác hiển thị đúng trạng thái, chỉ bỏ qua việc gửi thông báo.
    if (s.overdueAlertMuted) return 0;

    const actor = expenseActorForStatus(
      s.status as SuggestStatus,
      s.requestKind,
    );
    if (!actor) return 0;

    await this.notifyExpense(
      {
        suggestId: s.id!,
        title: '🚨 Đề xuất chi quá hạn',
        message:
          `Đề xuất ${s.code} đã quá ngày dự kiến chi ${daysLate} ngày` +
          ` (${s.expectedPaymentDate}), đang ở bước ${s.status}`,
        meta: { kind: 'overdue', status: s.status, daysLate },
      },
      {
        roles: [...(actor.owner ? [] : actor.roles), ExpenseRole.DIRECTOR],
        userIds: actor.owner && s.createdBy ? [s.createdBy] : [],
      },
    );

    return 1;
  }

  /**
   * Tắt/bật nhắc quá hạn cho riêng một đề xuất — dùng khi Giám đốc đã biết và
   * đang xử lý, không cần bị nhắc lại mỗi ngày nữa. Không ảnh hưởng đề xuất
   * khác, và không tắt cron chung (`reminder-settings`).
   */
  async setOverdueAlertMuted(id: number, muted: boolean) {
    const suggest = await this.repo.findOne({ where: { id } });
    if (!suggest || suggest.type !== SuggestType.EXPENSE_REQUEST) {
      throw new NotFoundException('Không tìm thấy đề xuất chi');
    }

    await this.repo.update(id, { overdueAlertMuted: muted });
    return { id, overdueAlertMuted: muted };
  }
}
