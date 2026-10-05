import { IsNull, MoreThanOrEqual, Not, Or } from 'typeorm';
import { TeacherService } from './teacher.service';
import { TeachingSession } from './entities/teaching-session.entity';
import {
  TEACHER_COLLABORATOR_ROLE,
  TEACHER_STAFF_ROLE,
} from './teaching-roles';

describe('TeacherService.reapplyTeacherRate — đổi đơn giá/tiết của giáo viên', () => {
  const makeService = (teacher: any, roles: string[] | null) => {
    const update = jest
      .fn()
      .mockResolvedValueOnce({ affected: 81 })
      .mockResolvedValueOnce({ affected: 621 });
    const sessionRepo = {
      manager: { transaction: jest.fn((callback) => callback({ update })) },
    };
    const service = new TeacherService(
      { findOne: jest.fn().mockResolvedValue(teacher) } as any,
      sessionRepo as any,
      {
        findOne: jest
          .fn()
          .mockResolvedValue(roles ? { id: teacher.employeeId, roles } : null),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, update };
  };

  const ctv = { id: 3, employeeId: 42, defaultRatePerPeriod: 120000 };

  it('điền buổi thiếu giá ở mọi ngày + đổi giá mọi buổi từ ngày áp dụng', async () => {
    const { service, update } = makeService(ctv, [TEACHER_COLLABORATOR_ROLE]);

    await expect(service.reapplyTeacherRate(3, '2026-10-01')).resolves.toEqual({
      fromDate: '2026-10-01',
      filledMissing: 81,
      repriced: 621,
    });
    expect(update).toHaveBeenNthCalledWith(
      1,
      TeachingSession,
      { teacherId: 3, ratePerPeriod: IsNull(), gasAllowance: IsNull() },
      { ratePerPeriod: 120000 },
    );
    // Buổi trước ngày áp dụng giữ giá cũ; buổi đã có phụ cấp xăng không đụng.
    expect(update).toHaveBeenNthCalledWith(
      2,
      TeachingSession,
      {
        teacherId: 3,
        date: MoreThanOrEqual('2026-10-01'),
        gasAllowance: IsNull(),
        ratePerPeriod: Or(IsNull(), Not(120000)),
      },
      { ratePerPeriod: 120000 },
    );
  });

  it('không chọn ngày áp dụng → chỉ điền buổi thiếu giá', async () => {
    const { service, update } = makeService(ctv, [TEACHER_COLLABORATOR_ROLE]);

    await expect(service.reapplyTeacherRate(3)).resolves.toEqual({
      fromDate: null,
      filledMissing: 81,
      repriced: 0,
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('giáo viên chưa có tài khoản vẫn tính theo tiết', async () => {
    const { service, update } = makeService({ ...ctv, employeeId: null }, null);

    await service.reapplyTeacherRate(3, '2026-10-01');
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('giáo viên công ty (nhận phụ cấp xăng) hoặc chưa khai giá → không đổi buổi nào', async () => {
    const staff = makeService(ctv, [TEACHER_STAFF_ROLE]);
    await expect(
      staff.service.reapplyTeacherRate(3, '2026-10-01'),
    ).resolves.toEqual({
      fromDate: '2026-10-01',
      filledMissing: 0,
      repriced: 0,
    });
    expect(staff.update).not.toHaveBeenCalled();

    const noRate = makeService({ ...ctv, defaultRatePerPeriod: null }, [
      TEACHER_COLLABORATOR_ROLE,
    ]);
    await noRate.service.reapplyTeacherRate(3, '2026-10-01');
    expect(noRate.update).not.toHaveBeenCalled();
  });
});
