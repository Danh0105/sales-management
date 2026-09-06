import { TeachingSessionService } from './teaching-session.service';
import { NotificationType } from '../notifications/enums/notification-type.enum';
import {
  TEACHING_CHECKIN_ALERT_LATE_MINUTES,
  TEACHING_CHECKIN_ALERT_LEAD_MINUTES,
} from '../notifications/constants/teaching-checkin-alert.constant';

/**
 * Báo động "sắp tới giờ dạy mà giáo viên chưa check-in".
 * Test chạy thẳng vào service với repo giả — không đụng DB, không chờ cron.
 */

const CHAINABLE = [
  'innerJoin',
  'leftJoin',
  'where',
  'andWhere',
  'select',
  'addSelect',
  'orderBy',
  'addOrderBy',
];

function makeQueryBuilder(rows: any[] = []) {
  const qb: any = { calls: {} as Record<string, any> };
  for (const method of CHAINABLE) {
    qb[method] = jest.fn((...args: any[]) => {
      // Giữ lại tham số của where/andWhere để khẳng định được cửa sổ thời gian.
      if ((method === 'where' || method === 'andWhere') && args[1]) {
        Object.assign(qb.calls, args[1]);
      }
      return qb;
    });
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

/** 08:00 giờ VN của một ngày cố định, để số phút trong test không đổi theo lúc chạy. */
const NOW = new Date('2026-08-17T01:00:00.000Z'); // 08:00 +07

function sessionRow(over: Record<string, any> = {}) {
  return {
    id: 1,
    date: '2026-08-17',
    startTime: '08:05:00',
    teacherId: 5,
    schoolId: 10,
    checkinAt: null,
    teacherName: 'Hoàng Đức Em',
    schoolName: 'Tiểu học Dịch Vọng A',
    className: '1A1',
    ...over,
  };
}

function makeService(
  rows: any[],
  recipients: Array<number | { id: number; zaloUserId: string | null }> = [11, 12],
) {
  const managers = recipients.map((r) =>
    typeof r === 'number' ? { id: r, zaloUserId: null } : r,
  );
  const sessionQb = makeQueryBuilder(rows);
  const employeeQb = makeQueryBuilder(managers);

  const sessionRepo: any = {
    createQueryBuilder: jest.fn().mockReturnValue(sessionQb),
    update: jest.fn().mockResolvedValue({ affected: rows.length }),
  };
  const employeeRepo: any = {
    createQueryBuilder: jest.fn().mockReturnValue(employeeQb),
  };
  const notificationService: any = {
    create: jest.fn().mockResolvedValue({ id: 1 }),
  };
  const fcmService: any = { sendToMultiple: jest.fn().mockResolvedValue(null) };
  const employeeFcmTokenService: any = {
    getTokens: jest
      .fn()
      .mockResolvedValue(
        managers.map(({ id }) => ({ employeeId: id, token: `t${id}` })),
      ),
  };
  const zaloNotifyService: any = {
    sendToMany: jest.fn().mockResolvedValue({ sent: 1, failed: 0 }),
  };

  const service = new TeachingSessionService(
    sessionRepo,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    notificationService,
    fcmService,
    employeeFcmTokenService,
    undefined as any,
    employeeRepo,
    zaloNotifyService,
  );

  return {
    service,
    sessionRepo,
    sessionQb,
    notificationService,
    fcmService,
    employeeFcmTokenService,
    zaloNotifyService,
  };
}

describe('Báo động giáo viên chưa check-in', () => {
  it('mặc định báo trước 5 phút', () => {
    expect(TEACHING_CHECKIN_ALERT_LEAD_MINUTES).toBe(5);
  });

  it('mặc định xóa cảnh báo khỏi banner sau khi trễ 10 phút', () => {
    expect(TEACHING_CHECKIN_ALERT_LATE_MINUTES).toBe(10);
  });

  it('banner chỉ lấy các buổi từ trễ 10 phút đến trước giờ 5 phút', async () => {
    const { service, sessionQb } = makeService([sessionRow()]);

    await service.findCheckinAlerts(NOW);

    expect(sessionQb.calls.from).toBe('07:50:00');
    expect(sessionQb.calls.until).toBe('08:05:00');
  });

  it('không có buổi nào thì không gửi gì', async () => {
    const { service, notificationService, sessionRepo } = makeService([]);

    const result = await service.runMissingCheckinAlerts(NOW);

    expect(result).toEqual({ sessions: 0, recipients: 0, zaloSent: 0 });
    expect(notificationService.create).not.toHaveBeenCalled();
    // Không có gì để báo thì cũng không được chạm vào cột đánh dấu.
    expect(sessionRepo.update).not.toHaveBeenCalled();
  });

  it('quét đúng cửa sổ quanh giờ vào tiết', async () => {
    const { service, sessionQb } = makeService([sessionRow()]);

    await service.runMissingCheckinAlerts(NOW);

    // 08:00 ± 5 phút
    expect(sessionQb.calls.from).toBe('07:55:00');
    expect(sessionQb.calls.to).toBe('08:05:00');
    expect(sessionQb.calls.date).toBe('2026-08-17');
  });

  it('gửi cho mọi tài khoản Giáo vụ / Nhân sự và đánh dấu đã báo', async () => {
    const { service, sessionRepo, notificationService, fcmService } = makeService([
      sessionRow(),
    ]);

    const result = await service.runMissingCheckinAlerts(NOW);

    expect(result).toEqual({ sessions: 1, recipients: 2, zaloSent: 0 });
    expect(notificationService.create).toHaveBeenCalledTimes(2);

    const [first] = notificationService.create.mock.calls[0];
    expect(first.receiverId).toBe(11);
    expect(first.type).toBe(NotificationType.TEACHING_CHECKIN_ALERT);
    expect(first.meta.sessionId).toBe(1);
    expect(first.meta.route).toBe('/nhan-su/cham-cong');

    expect(sessionRepo.update).toHaveBeenCalledWith(
      expect.anything(),
      { checkinAlertAt: NOW },
    );
    expect(fcmService.sendToMultiple).toHaveBeenCalledTimes(1);
  });

  it('một buổi: nêu tên giáo viên và số phút còn lại', async () => {
    const { service, notificationService } = makeService([sessionRow()]);

    await service.runMissingCheckinAlerts(NOW);

    const [payload] = notificationService.create.mock.calls[0];
    expect(payload.message).toContain('Hoàng Đức Em');
    expect(payload.message).toContain('08:05');
    expect(payload.message).toContain('1A1');
    expect(payload.message).toContain('còn 5 phút nữa vào tiết');
  });

  it('buổi đã qua giờ thì báo là trễ chứ không báo âm phút', async () => {
    const { service, notificationService } = makeService([
      sessionRow({ startTime: '07:57:00' }),
    ]);

    await service.runMissingCheckinAlerts(NOW);

    const [payload] = notificationService.create.mock.calls[0];
    expect(payload.message).toContain('đã quá giờ vào tiết 3 phút');
    expect(payload.message).not.toContain('-3');
  });

  it('nhiều buổi gộp thành một thông báo, không spam từng buổi', async () => {
    const { service, notificationService } = makeService([
      sessionRow({ id: 1 }),
      sessionRow({ id: 2, teacherName: 'Vũ Thị Phương', className: '3A1' }),
      sessionRow({ id: 3, teacherName: 'Đỗ Quang Huy', className: '2A1' }),
    ]);

    const result = await service.runMissingCheckinAlerts(NOW);

    expect(result.sessions).toBe(3);
    // 3 buổi × 2 người nhận vẫn chỉ 2 thông báo.
    expect(notificationService.create).toHaveBeenCalledTimes(2);

    const [payload] = notificationService.create.mock.calls[0];
    expect(payload.message).toContain('3 buổi dạy chưa check-in');
    expect(payload.message).toContain('Vũ Thị Phương');
    expect(payload.meta.sessionCount).toBe(3);
    // Nhiều buổi thì không deep-link vào buổi nào cả.
    expect(payload.meta.sessionId).toBeUndefined();
    expect(payload.meta.sessions).toHaveLength(3);
  });

  it('chưa có tài khoản Giáo vụ / Nhân sự thì vẫn đánh dấu, không ném lỗi', async () => {
    const { service, sessionRepo, notificationService } = makeService(
      [sessionRow()],
      [],
    );

    const result = await service.runMissingCheckinAlerts(NOW);

    expect(result).toEqual({ sessions: 1, recipients: 0, zaloSent: 0 });
    expect(notificationService.create).not.toHaveBeenCalled();
    expect(sessionRepo.update).toHaveBeenCalled();
  });

  describe('nới lỏng theo block cùng trường', () => {
    it('tiết đã được tiết trước cùng trường check-in thì không bị nhắc', async () => {
      const { service, sessionQb, notificationService, sessionRepo } =
        makeService([]);
      // Buổi 1 (tiết đầu) đã check-in, buổi 2 (cùng trường) chưa — block coi
      // như đã có người check-in nên buổi 2 không cần tự check-in nữa.
      sessionQb.getRawMany.mockResolvedValueOnce([
        sessionRow({ id: 1, startTime: '07:00:00', checkinAt: new Date() }),
        sessionRow({ id: 2, startTime: '08:05:00', checkinAt: null }),
      ]);

      const result = await service.runMissingCheckinAlerts(NOW);

      expect(result).toEqual({ sessions: 0, recipients: 0, zaloSent: 0 });
      expect(notificationService.create).not.toHaveBeenCalled();
      expect(sessionRepo.update).not.toHaveBeenCalled();
    });

    it('block chưa ai check-in thì tiết giữa/cuối vẫn không bị coi là thiếu check-in', async () => {
      const { service, sessionQb, notificationService, sessionRepo } =
        makeService([]);
      // Tiết đầu đã qua cửa sổ cảnh báo; tiết 2 không cần check-in nên không
      // được phát cảnh báo riêng dù cả block chưa thao tác.
      sessionQb.getRawMany.mockResolvedValueOnce([
        sessionRow({ id: 1, startTime: '07:00:00', checkinAt: null }),
        sessionRow({ id: 2, startTime: '08:05:00', checkinAt: null }),
      ]);

      const result = await service.runMissingCheckinAlerts(NOW);

      expect(result).toEqual({ sessions: 0, recipients: 0, zaloSent: 0 });
      expect(notificationService.create).not.toHaveBeenCalled();
      expect(sessionRepo.update).not.toHaveBeenCalled();
    });
  });
});
