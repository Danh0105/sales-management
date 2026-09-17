import { In, LessThan } from 'typeorm';
import { NotificationType } from '../enums/notification-type.enum';
import {
  TEACHING_AUTO_NOTIFICATION_TYPES,
  TeachingNotificationCleanupService,
} from './teaching-notification-cleanup.service';

describe('TeachingNotificationCleanupService', () => {
  const repo = { delete: jest.fn().mockResolvedValue({ affected: 42 }) };
  const service = new TeachingNotificationCleanupService(repo as never);

  beforeEach(() => repo.delete.mockClear());

  it('xoá đúng nhóm giảng dạy, cũ hơn 7 ngày', async () => {
    const now = new Date('2026-09-11T03:00:00+07:00');
    const deleted = await service.runCleanup(now);

    expect(deleted).toBe(42);
    expect(repo.delete).toHaveBeenCalledWith({
      type: In([...TEACHING_AUTO_NOTIFICATION_TYPES]),
      createdAt: LessThan(new Date('2026-09-04T03:00:00+07:00')),
    });
  });

  it('không đụng thông báo nghiệp vụ do người gửi', () => {
    for (const kept of [
      NotificationType.POLICY,
      NotificationType.SUGGEST,
      NotificationType.REPORT,
      NotificationType.WEEKLY_PLAN,
      NotificationType.EXPENSE_REQUEST,
      NotificationType.SYSTEM,
    ]) {
      expect(TEACHING_AUTO_NOTIFICATION_TYPES).not.toContain(kept);
    }
  });

  it('bao phủ mọi loại TEACHING_* / TEACHER_* — thêm enum mới là phải quyết định', () => {
    const teachingTypes = Object.values(NotificationType).filter(
      (t) => t.startsWith('TEACHING_') || t.startsWith('TEACHER_'),
    );
    expect([...TEACHING_AUTO_NOTIFICATION_TYPES].sort()).toEqual(teachingTypes.sort());
  });
});
