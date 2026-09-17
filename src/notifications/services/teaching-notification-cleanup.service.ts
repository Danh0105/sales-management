import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { Notification } from '../entities/notification.entity';
import { NotificationType } from '../enums/notification-type.enum';
import { isCronLeader } from '../../utils/is-cron-leader';

/**
 * Các loại thông báo do module giảng dạy **tự sinh** — báo động check-in,
 * nhắc xác nhận lịch, kết quả xác nhận, nhắc báo giảng... — gửi cho giáo
 * viên, Nhân sự và Giáo vụ.
 *
 * Nhóm này sinh ra với khối lượng lớn (riêng CONFIRM_RESULT hơn 11.000 bản
 * ghi trong 2,5 tuần đầu) và chỉ có giá trị trong vài ngày: quá tuần thì
 * buổi dạy đã xong, lịch đã chốt. Giữ lại chỉ làm chậm hộp thông báo và
 * phình bảng.
 *
 * Các loại *_REQUEST xoá được an toàn: bản ghi thật của đề nghị (đổi vị
 * trí, mở tài khoản, thay giáo viên) nằm ở bảng riêng với trạng thái riêng —
 * thông báo chỉ là con trỏ tới đó. Người duyệt vẫn thấy đề nghị chờ trong
 * màn hình danh sách dù thông báo đã bị dọn.
 *
 * Cố ý KHÔNG đụng POLICY / SUGGEST / REPORT / WEEKLY_PLAN / EXPENSE_REQUEST:
 * đó là thông báo nghiệp vụ do người gửi, vòng đời khác hẳn.
 */
export const TEACHING_AUTO_NOTIFICATION_TYPES: readonly NotificationType[] = [
  NotificationType.TEACHING_SCHEDULE,
  NotificationType.TEACHING_CHECKIN_ALERT,
  NotificationType.TEACHING_SCHEDULE_CONFIRM_REQUEST,
  NotificationType.TEACHING_SCHEDULE_CONFIRM_RESULT,
  NotificationType.TEACHING_SCHEDULE_CONFIRM_ALERT,
  NotificationType.TEACHING_LESSON_REPORT_ALERT,
  NotificationType.TEACHING_REPLACEMENT_REQUEST,
  NotificationType.TEACHER_LOCATION_CHANGE_REQUEST,
  NotificationType.TEACHER_LOCATION_CHANGE_RESULT,
  NotificationType.TEACHER_ACCOUNT_REQUEST,
  NotificationType.TEACHER_ACCOUNT_RESULT,
];

/** Giữ thông báo tự động của module giảng dạy trong ngần này ngày. */
export const TEACHING_NOTIFICATION_RETENTION_DAYS = 7;

@Injectable()
export class TeachingNotificationCleanupService {
  private readonly logger = new Logger(TeachingNotificationCleanupService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly repo: Repository<Notification>,
  ) {}

  /** 03:00 mỗi ngày — giờ vắng, không tranh tài nguyên với báo động check-in. */
  @Cron('0 3 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleCleanup() {
    // dev (sales-be) và prod chạy chung DB, mỗi process tự đăng ký cron
    // riêng. Xoá thì chạy hai lần không gây hại, nhưng vẫn giữ đúng quy ước
    // để log không báo hai lần. Xem is-cron-leader.ts.
    if (!isCronLeader()) return;
    try {
      const deleted = await this.runCleanup();
      this.logger.log(
        `Đã xoá ${deleted} thông báo tự động của module giảng dạy cũ hơn ${TEACHING_NOTIFICATION_RETENTION_DAYS} ngày`,
      );
    } catch (error) {
      this.logger.error('Dọn thông báo giảng dạy thất bại', error as Error);
    }
  }

  /**
   * Tách khỏi `@Cron` để gọi tay và viết test không phải chờ đồng hồ.
   * Trả về số bản ghi đã xoá.
   */
  async runCleanup(
    now = new Date(),
    retentionDays = TEACHING_NOTIFICATION_RETENTION_DAYS,
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.repo.delete({
      type: In([...TEACHING_AUTO_NOTIFICATION_TYPES]),
      createdAt: LessThan(cutoff),
    });
    return result.affected ?? 0;
  }
}
