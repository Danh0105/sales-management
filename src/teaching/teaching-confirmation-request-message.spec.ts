import { NotificationType } from '../notifications/enums/notification-type.enum';
import { TeachingScheduleService } from './teaching-schedule.service';
import { TeachingSessionService } from './teaching-session.service';

/**
 * Nội dung yêu cầu xác nhận gửi giáo viên (trong app + Zalo): phải ghi rõ môn,
 * lớp, trường để giáo viên biết lịch nào; kèm `meta.summary` làm dòng trong
 * tin Zalo gộp khi Nhân sự xếp nhiều lịch liền nhau.
 */

const PLACE_ROW = {
  schoolName: 'Tiểu học Dịch Vọng A',
  className: '1A1',
  subjectName: 'Tin học',
};

function makePlaceQueryBuilder(row: any) {
  const qb: any = {};
  for (const method of ['leftJoin', 'select', 'where']) qb[method] = jest.fn(() => qb);
  qb.getRawOne = jest.fn().mockResolvedValue(row);
  return qb;
}

function makeDeps(placeRepo: any) {
  return {
    notificationService: { create: jest.fn().mockResolvedValue({ id: 1 }) },
    fcmService: { sendToMultiple: jest.fn().mockResolvedValue(null) },
    employeeFcmTokenService: { getTokens: jest.fn().mockResolvedValue([]) },
    placeRepo,
  };
}

function makeSessionService(placeRepo: any) {
  const deps = makeDeps(placeRepo);
  const service = new TeachingSessionService(
    placeRepo,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    deps.notificationService as any,
    deps.fcmService as any,
    deps.employeeFcmTokenService as any,
    undefined as any,
    undefined as any,
    undefined as any,
  );
  return { service, ...deps };
}

function makeScheduleService(placeRepo: any) {
  const deps = makeDeps(placeRepo);
  const service = new TeachingScheduleService(
    placeRepo,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    deps.notificationService as any,
    deps.fcmService as any,
    deps.employeeFcmTokenService as any,
    undefined as any,
  );
  return { service, ...deps };
}

const TEACHER = { id: 5, name: 'Cô A', employeeId: 30 };
const SESSION = { id: 7, date: '2026-11-03', startTime: '07:30:00' };
const SCHEDULE = {
  id: 9,
  dayOfWeek: 2,
  startTime: '07:30:00',
  endTime: '08:05:00',
  effectiveFrom: '2026-11-03',
};

describe('Yêu cầu xác nhận buổi dạy — nội dung', () => {
  it('ghi môn – lớp, trường; meta có summary + link màn lịch dạy', async () => {
    const { service, notificationService } = makeSessionService({
      createQueryBuilder: jest.fn(() => makePlaceQueryBuilder(PLACE_ROW)),
    });

    await (service as any).notifyConfirmationRequest(SESSION, TEACHER);

    expect(notificationService.create).toHaveBeenCalledWith({
      receiverId: 30,
      type: NotificationType.TEACHING_SCHEDULE_CONFIRM_REQUEST,
      message:
        'Bạn được xếp buổi dạy ngày 03/11/2026 lúc 07:30 – môn Tin học – 1A1, Tiểu học Dịch Vọng A. ' +
        'Vui lòng xác nhận hoặc từ chối.',
      meta: expect.objectContaining({
        url: '/#/giao-vien/lich-day',
        entityType: 'session',
        sessionId: 7,
        summary: 'Buổi ngày 03/11/2026 lúc 07:30 – môn Tin học – 1A1, Tiểu học Dịch Vọng A',
      }),
    });
  });

  it('đổi lịch thì summary ghi rõ "Đổi lịch"', async () => {
    const { service, notificationService } = makeSessionService({
      createQueryBuilder: jest.fn(() => makePlaceQueryBuilder(PLACE_ROW)),
    });

    await (service as any).notifyConfirmationRequest(SESSION, TEACHER, 'rescheduled');

    const { message, meta } = notificationService.create.mock.calls[0][0];
    expect(message).toMatch(/^Buổi dạy của bạn đã đổi lịch sang ngày 03\/11\/2026 lúc 07:30 – môn Tin học/);
    expect(meta.summary).toMatch(/^Đổi lịch: buổi ngày 03\/11\/2026/);
  });

  it('tra trường/lớp lỗi thì vẫn gửi, chỉ thiếu phần đó', async () => {
    const { service, notificationService } = makeSessionService({
      createQueryBuilder: jest.fn(() => {
        throw new Error('DB lỗi');
      }),
    });

    await (service as any).notifyConfirmationRequest(SESSION, TEACHER);

    expect(notificationService.create.mock.calls[0][0].message).toBe(
      'Bạn được xếp buổi dạy ngày 03/11/2026 lúc 07:30. Vui lòng xác nhận hoặc từ chối.',
    );
  });

  it('giáo viên không có tài khoản thì không báo', async () => {
    const { service, notificationService } = makeSessionService({
      createQueryBuilder: jest.fn(() => makePlaceQueryBuilder(PLACE_ROW)),
    });

    await (service as any).notifyConfirmationRequest(SESSION, { ...TEACHER, employeeId: null });

    expect(notificationService.create).not.toHaveBeenCalled();
  });
});

describe('Yêu cầu xác nhận mẫu lịch — nội dung', () => {
  it('ghi thứ, giờ, môn – lớp, trường và ngày bắt đầu dạng dd/mm/yyyy', async () => {
    const { service, notificationService } = makeScheduleService({
      createQueryBuilder: jest.fn(() => makePlaceQueryBuilder(PLACE_ROW)),
    });

    await (service as any).notifyConfirmationRequest(SCHEDULE, TEACHER);

    const { message, meta } = notificationService.create.mock.calls[0][0];
    expect(message).toBe(
      'Bạn được xếp lịch dạy Thứ Hai 07:30–08:05 – môn Tin học – 1A1, Tiểu học Dịch Vọng A, từ 03/11/2026. ' +
        'Vui lòng xác nhận hoặc từ chối.',
    );
    expect(meta).toEqual(
      expect.objectContaining({
        url: '/#/giao-vien/lich-day',
        entityType: 'schedule',
        scheduleId: 9,
        summary: 'Lịch Thứ Hai 07:30–08:05 – môn Tin học – 1A1, Tiểu học Dịch Vọng A, từ 03/11/2026',
      }),
    );
  });

  it('lớp không có tên thì chỉ ghi môn và trường', async () => {
    const { service, notificationService } = makeScheduleService({
      createQueryBuilder: jest.fn(() =>
        makePlaceQueryBuilder({ ...PLACE_ROW, className: null }),
      ),
    });

    await (service as any).notifyConfirmationRequest(SCHEDULE, TEACHER);

    expect(notificationService.create.mock.calls[0][0].message).toContain(
      '07:30–08:05 – môn Tin học – Tiểu học Dịch Vọng A, từ 03/11/2026',
    );
  });
});
