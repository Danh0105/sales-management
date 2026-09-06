import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, SelectQueryBuilder } from 'typeorm';
import { Notification } from '../entities/notification.entity';
import { Employee } from '../../employee/employee.entity';
import { NotifyService } from '../../notify-zalo/notify.service';

import { NotificationType } from '../enums/notification-type.enum';
import { TEACHING_SCHEDULE_ROUTE } from '../constants/teaching-schedule.constant';
import { NotificationGateway } from '../gateways/notification.geteway';

/**
 * Nhóm type giảng dạy gửi kèm Zalo OA — KHÔNG gồm TEACHING_CHECKIN_ALERT vì
 * luồng đó tự gộp nhiều buổi/gửi Zalo riêng (xem
 * teaching-session.service.ts#sendCheckinAlertToZalo), gộp thêm ở đây sẽ gửi
 * trùng 2 lần cho Giáo vụ/Nhân sự.
 */
const TEACHING_ZALO_TYPES = new Set<NotificationType>([
  NotificationType.TEACHING_SCHEDULE,
  NotificationType.TEACHING_SCHEDULE_CONFIRM_REQUEST,
  NotificationType.TEACHING_SCHEDULE_CONFIRM_RESULT,
  NotificationType.TEACHING_SCHEDULE_CONFIRM_ALERT,
  NotificationType.TEACHING_LESSON_REPORT_ALERT,
  NotificationType.TEACHING_REPLACEMENT_REQUEST,
  NotificationType.TEACHER_LOCATION_CHANGE_REQUEST,
  NotificationType.TEACHER_LOCATION_CHANGE_RESULT,
  NotificationType.TEACHER_ACCOUNT_REQUEST,
  NotificationType.TEACHER_ACCOUNT_RESULT,
]);

/**
 * Đọc tại thời điểm gọi (không chốt hằng số) — ConfigModule nạp `.env` sau
 * khi module TS được import, chốt sớm có thể luôn đọc ra "tắt".
 *
 * Mặc định BẬT theo yêu cầu — tắt khẩn bằng `TEACHING_NOTIFICATION_ZALO=0`
 * nếu Zalo OA gặp sự cố mà không muốn chờ deploy lại.
 */
const isTeachingNotificationZaloEnabled = () =>
  process.env.TEACHING_NOTIFICATION_ZALO !== '0';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectRepository(Notification)
    private repo: Repository<Notification>,

    private gateway: NotificationGateway,

    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,

    private readonly notifyService: NotifyService,
  ) {}

  /**
   * Gửi kèm Zalo OA cho thông báo giảng dạy — kênh phụ, không bao giờ được
   * làm hỏng việc tạo thông báo chính nên mọi lỗi đều bị nuốt ở đây.
   */
  private async pushTeachingZalo(
    receiverId: number,
    type: NotificationType,
    message?: string | null,
  ) {
    if (!message || !TEACHING_ZALO_TYPES.has(type)) return;
    if (!isTeachingNotificationZaloEnabled()) return;

    try {
      const employee = await this.employeeRepo.findOne({
        where: { id: receiverId },
        select: ['id', 'zaloUserId'],
      });
      if (!employee?.zaloUserId) return;

      await this.notifyService.sendMessage(employee.zaloUserId, message);
    } catch (error) {
      this.logger.warn(
        `Không gửi được Zalo OA cho nhân viên #${receiverId}: ${(error as Error).message}`,
      );
    }
  }

  private getEventByType(type: NotificationType) {
    switch (type) {
      case NotificationType.POLICY:
        return 'policy-notification:new';

      case NotificationType.SUGGEST:
        return 'suggest-notification:new';

      case NotificationType.REPORT:
        return 'report-notification:new';

      case NotificationType.WEEKLY_PLAN:
        return 'weekly-plan:new';

      case NotificationType.EXPENSE_REQUEST:
        return 'expense-request-notification:new';

      case NotificationType.TEACHING_SCHEDULE:
        return 'teaching-schedule-notification:new';

      case NotificationType.TEACHING_CHECKIN_ALERT:
        return 'teaching-checkin-alert:new';

      case NotificationType.TEACHING_SCHEDULE_CONFIRM_REQUEST:
        return 'teaching-schedule-confirm-request:new';

      case NotificationType.TEACHING_SCHEDULE_CONFIRM_RESULT:
        return 'teaching-schedule-confirm-result:new';

      case NotificationType.TEACHING_SCHEDULE_CONFIRM_ALERT:
        return 'teaching-schedule-confirm-alert:new';

      case NotificationType.TEACHING_LESSON_REPORT_ALERT:
        return 'teaching-lesson-report-alert:new';

      case NotificationType.TEACHING_REPLACEMENT_REQUEST:
        return 'teaching-replacement-request:new';

      case NotificationType.TEACHER_LOCATION_CHANGE_REQUEST:
        return 'teacher-location-change-request:new';

      case NotificationType.TEACHER_LOCATION_CHANGE_RESULT:
        return 'teacher-location-change-result:new';

      case NotificationType.TEACHER_ACCOUNT_REQUEST:
        return 'teacher-account-request:new';

      case NotificationType.TEACHER_ACCOUNT_RESULT:
        return 'teacher-account-result:new';

      default:
        return 'notification:new';
    }
  }
  // ======================================================
  // CREATE
  // ======================================================

  async create(data: Partial<Notification>) {
    const notification = this.repo.create(data);

    const saved = await this.repo.save(notification);

    const event = this.getEventByType(saved.type);

    this.gateway.emitToUser(saved.receiverId, event, saved);

    await this.pushTeachingZalo(saved.receiverId, saved.type, saved.message);

    return saved;
  }

  // ======================================================
  // UNREAD COUNT
  // ======================================================

  async countUnread(receiverId: number) {
    return this.repo.count({
      where: {
        receiverId,
        isRead: false,
      },
    });
  }

  // ======================================================
  // GET UNREAD
  // ======================================================

  async getUnreadNotifications(receiverId: number) {
    return this.repo.find({
      where: {
        receiverId,
        isRead: false,
      },

      order: {
        createdAt: 'DESC',
      },

      take: 20,
    });
  }

  // ======================================================
  // MARK AS READ
  // ======================================================

  async markAsRead(id: number, receiverId: number) {
    await this.repo.update(
      {
        id,
        receiverId,
      },
      {
        isRead: true,
      },
    );

    return {
      success: true,
    };
  }

  // ======================================================
  // MARK ALL
  // ======================================================

  async markAllAsRead(receiverId: number) {
    await this.repo.update(
      {
        receiverId,
        isRead: false,
      },
      {
        isRead: true,
      },
    );

    return {
      success: true,
    };
  }

  /**
   * Đánh dấu đã đọc toàn bộ thông báo xác nhận gắn với đúng một buổi dạy.
   * Chỉ cập nhật thông báo của giáo viên đang thao tác; thông báo gửi cho
   * Giáo vụ/Nhân sự vẫn giữ nguyên trạng thái chưa đọc.
   */
  async markTeachingSessionConfirmationAsRead(
    receiverId: number,
    sessionId: number,
  ) {
    await this.repo
      .createQueryBuilder()
      .update(Notification)
      .set({ isRead: true })
      .where('"receiverId" = :receiverId', { receiverId })
      .andWhere('"isRead" = false')
      .andWhere('type IN (:...types)', {
        types: [
          NotificationType.TEACHING_SCHEDULE_CONFIRM_REQUEST,
          NotificationType.TEACHING_SCHEDULE_CONFIRM_RESULT,
          NotificationType.TEACHING_SCHEDULE_CONFIRM_ALERT,
        ],
      })
      .andWhere(`meta ->> 'sessionId' = :sessionId`, {
        sessionId: String(sessionId),
      })
      .execute();

    return { success: true };
  }

  // ======================================================
  // PAGINATION
  // ======================================================

  async findAllWithPagination({
    receiverId,
    page = 1,
    limit = 10,
    tab,
    type,
  }: {
    receiverId: number;

    page?: number;

    limit?: number;

    tab?: 'unread' | 'read';

    type?: NotificationType;
  }) {
    const where: any = {
      receiverId,
    };

    if (tab === 'unread') {
      where.isRead = false;
    }

    if (tab === 'read') {
      where.isRead = true;
    }

    if (type) {
      where.type = type;
    }

    const [data, total] = await this.repo.findAndCount({
      where,

      order: {
        createdAt: 'DESC',
      },

      skip: (page - 1) * limit,

      take: limit,
    });

    return {
      data,

      total,

      page,

      limit,

      totalPages: Math.ceil(total / limit),
    };
  }
  async createNotifications({
    receiverIds,

    type,

    entityId,

    message,

    senderId,

    meta,
  }: {
    receiverIds: number[];

    type: NotificationType;

    entityId?: number;

    message?: string;

    senderId?: number;

    meta?: Record<string, any>;
  }) {
    // remove duplicate ids
    const uniqueReceiverIds = [...new Set(receiverIds)];

    // create entities
    const notifications = uniqueReceiverIds.map((receiverId) =>
      this.repo.create({
        receiverId,

        senderId,

        type,

        entityId,

        message,

        meta,
      }),
    );

    // bulk insert
    const saved = await this.repo.save(notifications);

    // realtime socket
    for (const notification of saved) {
      const event = this.getEventByType(notification.type);

      this.gateway.emitToUser(
        notification.receiverId,

        event,

        notification,
      );
    }

    // Cùng 1 message cho cả lô nên gửi Zalo hàng loạt thay vì từng người.
    if (message && TEACHING_ZALO_TYPES.has(type) && isTeachingNotificationZaloEnabled()) {
      try {
        const employees = await this.employeeRepo.find({
          where: { id: In(uniqueReceiverIds) },
          select: ['id', 'zaloUserId'],
        });
        const zaloUserIds = employees
          .map((employee) => employee.zaloUserId)
          .filter((id): id is string => !!id);

        if (zaloUserIds.length) {
          await this.notifyService.sendToMany(zaloUserIds, message);
        }
      } catch (error) {
        this.logger.warn(
          `Không gửi được Zalo OA hàng loạt (type=${type}): ${(error as Error).message}`,
        );
      }
    }

    return saved;
  }
  /**
   * Đánh dấu đã đọc TOÀN BỘ thông báo (mọi người nhận) của 1 type+entity —
   * dùng khi thao tác đã CHỐT xong (duyệt/từ chối cuối cùng, không ai còn xử
   * lý tiếp được nữa), nên thông báo "cần duyệt" cũ không còn ý nghĩa với bất
   * kỳ ai trong số người nhận ban đầu, kể cả người không phải là người thao
   * tác (vd. đề xuất gửi cả saleadmin lẫn giám đốc, giám đốc duyệt xong thì
   * saleadmin cũng hết việc phải làm với đề xuất đó).
   */
  async markAllAsReadByTypeAndEntity(type: NotificationType, entityId: number) {
    await this.repo.update(
      { type, entityId, isRead: false },
      { isRead: true },
    );
    return { success: true };
  }

  /**
   * Đánh dấu đã đọc thông báo của 1 type+entity nhưng CHỈ cho đúng người vừa
   * thao tác — dùng cho bước kiểm duyệt TRUNG GIAN (vd. Sales Admin kiểm
   * duyệt trước khi giám đốc quyết định cuối cùng): người kiểm duyệt xong
   * việc của họ, nhưng người khác (giám đốc) vẫn cần thấy "cần duyệt".
   */
  async markAsReadByTypeEntityForReceiver(
    type: NotificationType,
    entityId: number,
    receiverId: number,
  ) {
    await this.repo.update(
      { type, entityId, receiverId, isRead: false },
      { isRead: true },
    );
    return { success: true };
  }

  /**
   * Như trên nhưng cho MỘT NHÓM người nhận — dùng khi một bước đã có người xử
   * lý xong thì lời nhắc "đến lượt bạn" của những người CÙNG giữ bước đó cũng
   * hết ý nghĩa (giám đốc 2, 3 không cần thấy "cần duyệt" nữa khi giám đốc 1
   * đã duyệt), nhưng thông báo của các nhóm khác (người tạo đơn, bước sau...)
   * thì giữ nguyên chưa đọc.
   */
  async markAsReadByTypeEntityForReceivers(
    type: NotificationType,
    entityId: number,
    receiverIds: number[],
  ) {
    const ids = [...new Set(receiverIds)].filter((id) => !!id);
    if (!ids.length) return { success: true, updated: 0 };

    const result = await this.repo.update(
      { type, entityId, receiverId: In(ids), isRead: false },
      { isRead: true },
    );
    return { success: true, updated: result.affected ?? 0 };
  }

  async markAllAsReadByType(receiverId: number, type: NotificationType) {
    await this.repo.update(
      {
        receiverId,
        type,
        isRead: false,
      },
      {
        isRead: true,
      },
    );

    return {
      success: true,
    };
  }
  async countUnreadByType(receiverId: number, type: NotificationType) {
    return this.repo.count({
      where: {
        receiverId,

        type,

        isRead: false,
      },
    });
  }
  async findByType({
    receiverId,
    type,
    page = 1,
    limit = 10,
    tab,
  }: {
    receiverId: number;

    type: NotificationType;

    page?: number;

    limit?: number;

    tab?: 'unread' | 'read';
  }) {
    const where: any = {
      receiverId,

      type,
    };

    if (tab === 'unread') {
      where.isRead = false;
    }

    if (tab === 'read') {
      where.isRead = true;
    }

    const [data, total] = await this.repo.findAndCount({
      where,

      order: {
        createdAt: 'DESC',
      },

      skip: (page - 1) * limit,

      take: limit,
    });

    return {
      data,

      total,

      page,

      limit,

      totalPages: Math.ceil(total / limit),
    };
  }
  async findAllEmployeesWithNotifications({
    receiverId,
    type,
    date,
  }: {
    receiverId: number;
    type: NotificationType;
    date: string;
  }) {
    const rows = await this.repo.manager
      .createQueryBuilder()
      .select('e.id', 'senderId')
      .addSelect('e.name', 'senderName')
      .addSelect('COUNT(n.id)', 'count')
      .addSelect(
        `SUM(CASE WHEN n."isRead" = false THEN 1 ELSE 0 END)`,
        'unreadCount',
      )
      .addSelect('MAX(n."createdAt")', 'latestAt')
      .from('employee', 'e')
      .leftJoin(
        'notification',
        'n',
        'n."senderId" = e.id AND n."receiverId" = :receiverId AND n.type = :type AND DATE(n."createdAt") = :date',
        { receiverId, type, date },
      )
      .where('e."isActive" = true')
      .andWhere('e.id != :receiverId', { receiverId })
      .groupBy('e.id')
      .addGroupBy('e.name')
      .orderBy(`"unreadCount"`, 'DESC')
      .addOrderBy(`"count"`, 'DESC')
      .addOrderBy('e.name', 'ASC')
      .getRawMany();

    return {
      date,
      data: rows.map((row) => ({
        senderId: row.senderId,
        senderName: row.senderName,
        count: Number(row.count || 0),
        unreadCount: Number(row.unreadCount || 0),
        latestAt: row.latestAt || null,
      })),
    };
  }

  async markAllAsReadBySender({
    receiverId,
    senderId,
    type,
  }: {
    receiverId: number;
    senderId: number;
    type?: NotificationType;
  }) {
    const where: any = {
      receiverId,
      senderId,
      isRead: false,
    };

    if (type) {
      where.type = type;
    }

    await this.repo.update(where, { isRead: true });

    return { success: true };
  }

  async findBySender({
    receiverId,
    senderId,
    type,
    tab,
    page = 1,
    limit = 20,
    date,
  }: {
    receiverId: number;
    senderId: number;
    type?: NotificationType;
    tab?: 'unread' | 'read';
    page?: number;
    limit?: number;
    date: string;
  }) {
    const qb = this.repo
      .createQueryBuilder('n')
      .where('n.receiverId = :receiverId', { receiverId })
      .andWhere('n.senderId = :senderId', { senderId })
      .andWhere('DATE(n.createdAt) = :date', { date });

    if (type) {
      qb.andWhere('n.type = :type', { type });
    }

    if (tab === 'unread') {
      qb.andWhere('n.isRead = false');
    } else if (tab === 'read') {
      qb.andWhere('n.isRead = true');
    }

    const [data, total] = await qb
      .orderBy('n.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      date,
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ======================================================
  // THÔNG BÁO LỊCH DẠY (giáo viên)
  // ======================================================

  /**
   * Gồm cả thông báo lịch dạy gửi trước khi có type riêng: hồi đó lưu là
   * SYSTEM, chỉ nhận ra được qua `meta.route`.
   */
  /**
   * Phạm vi "thông báo của module giảng dạy": lịch dạy gửi cho giáo viên và
   * báo động chưa check-in gửi cho Giáo vụ / Nhân sự. Gộp chung một feed vì
   * mỗi người chỉ nhận đúng loại thuộc vai trò của mình — giáo viên không bao
   * giờ là người nhận báo động, và ngược lại.
   */
  private teachingScheduleScope(qb: SelectQueryBuilder<Notification>) {
    return qb.andWhere(
      `(n.type IN (:...teachingTypes) OR (n.type = :systemType AND n.meta->>'route' = :teachingRoute))`,
      {
        teachingTypes: [
          NotificationType.TEACHING_SCHEDULE,
          NotificationType.TEACHING_CHECKIN_ALERT,
        ],
        systemType: NotificationType.SYSTEM,
        teachingRoute: TEACHING_SCHEDULE_ROUTE,
      },
    );
  }

  async findTeachingSchedule({
    receiverId,
    page = 1,
    limit = 10,
    tab,
  }: {
    receiverId: number;
    page?: number;
    limit?: number;
    tab?: 'unread' | 'read';
  }) {
    const qb = this.teachingScheduleScope(
      this.repo
        .createQueryBuilder('n')
        .where('n.receiverId = :receiverId', { receiverId }),
    );

    if (tab === 'unread') {
      qb.andWhere('n.isRead = false');
    } else if (tab === 'read') {
      qb.andWhere('n.isRead = true');
    }

    const [data, total] = await qb
      .orderBy('n.createdAt', 'DESC')
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

  async countUnreadTeachingSchedule(receiverId: number) {
    return this.teachingScheduleScope(
      this.repo
        .createQueryBuilder('n')
        .where('n.receiverId = :receiverId', { receiverId })
        .andWhere('n.isRead = false'),
    ).getCount();
  }

  async markAllTeachingScheduleAsRead(receiverId: number) {
    const rows = await this.teachingScheduleScope(
      this.repo
        .createQueryBuilder('n')
        .select('n.id', 'id')
        .where('n.receiverId = :receiverId', { receiverId })
        .andWhere('n.isRead = false'),
    ).getRawMany();

    const ids = rows.map((row) => Number(row.id));

    if (ids.length) {
      await this.repo.update({ id: In(ids) }, { isRead: true });
    }

    return { success: true, updated: ids.length };
  }

  async getNotificationStats(receiverId: number) {
    const rows = await this.repo
      .createQueryBuilder('n')
      .select('n.type', 'type')
      .addSelect('n.isRead', 'isRead')
      .addSelect('COUNT(*)', 'count')
      .where('n.receiverId = :receiverId', { receiverId })
      .groupBy('n.type')
      .addGroupBy('n.isRead')
      .getRawMany();

    // Luôn trả đủ key để client có thể đọc `stats[type].unread` ngay cả
    // khi người dùng chưa từng nhận loại thông báo đó. Danh sách viết tay
    // trước đây thiếu các loại TEACHING_* nên dropdown của Giáo vụ bị lỗi
    // khi truy cập `.unread` trên undefined.
    const result = Object.fromEntries(
      Object.values(NotificationType).map((type) => [
        type,
        { unread: 0, read: 0 },
      ]),
    ) as Record<NotificationType, { unread: number; read: number }>;

    rows.forEach((row) => {
      const type = row.type as NotificationType;
      const count = Number(row.count);

      if (row.isRead) {
        result[type].read = count;
      } else {
        result[type].unread = count;
      }
    });

    return result;
  }
}
