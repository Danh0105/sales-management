import { NotFoundException } from '@nestjs/common';
import { TeachingSessionService } from './teaching-session.service';
import { AssignmentStatus } from './teaching.enum';

/**
 * `GET /teaching-sessions/:id` từng chỉ mở cho role quản lý; mini app giáo
 * viên gọi để xem chi tiết buổi dạy và bị 403 ~500 lần/ngày. Giờ thu hẹp theo
 * phạm vi thay vì chặn cả role.
 */
describe('TeachingSessionService.findOne — phạm vi', () => {
  const row = { id: 1 };
  const item = (over: Record<string, unknown> = {}) => ({
    id: 1, teacherId: 7, recommendedTeacherId: null, schoolId: 50,
    assignmentStatus: AssignmentStatus.ASSIGNED, ...over,
  });

  function make(sessionItem: Record<string, unknown>, opts: { teacher?: { id: number } | null; ownsSchool?: boolean } = {}) {
    const service = Object.create(TeachingSessionService.prototype) as TeachingSessionService;
    Object.assign(service, {
      buildSessionQuery: () => ({ andWhere: () => ({ getRawOne: async () => row }) }),
      toSessionItem: () => sessionItem,
      enrichWithBlockFlags: async (items: unknown[]) => items,
      teacherRepo: { findOne: jest.fn(async () => opts.teacher ?? null) },
      sessionRepo: { manager: { count: jest.fn(async () => (opts.ownsSchool ? 1 : 0)) } },
    });
    return service;
  }

  it('quản lý / xem toàn bộ: thấy mọi buổi', async () => {
    await expect(make(item()).findOne(1, { kind: 'manage' })).resolves.toMatchObject({ id: 1 });
    await expect(make(item()).findOne(1, { kind: 'view' })).resolves.toMatchObject({ id: 1 });
  });

  it('giáo viên: thấy buổi của mình', async () => {
    const s = make(item({ teacherId: 7 }), { teacher: { id: 7 } });
    await expect(s.findOne(1, { kind: 'self', employeeId: 100 })).resolves.toMatchObject({ id: 1 });
  });

  it('giáo viên: thấy buổi đang mở tuyển và buổi được gợi ý cho mình', async () => {
    const open = make(item({ teacherId: null, assignmentStatus: AssignmentStatus.OPEN }), { teacher: { id: 7 } });
    await expect(open.findOne(1, { kind: 'self', employeeId: 100 })).resolves.toBeDefined();
    const rec = make(item({ teacherId: 9, recommendedTeacherId: 7 }), { teacher: { id: 7 } });
    await expect(rec.findOne(1, { kind: 'self', employeeId: 100 })).resolves.toBeDefined();
  });

  it('giáo viên: buổi của người khác → 404 (không lộ tồn tại)', async () => {
    const s = make(item({ teacherId: 9 }), { teacher: { id: 7 } });
    await expect(s.findOne(1, { kind: 'self', employeeId: 100 })).rejects.toThrow(NotFoundException);
  });

  it('tài khoản chưa gắn hồ sơ giáo viên → 404', async () => {
    const s = make(item(), { teacher: null });
    await expect(s.findOne(1, { kind: 'self', employeeId: 100 })).rejects.toThrow(NotFoundException);
  });

  it('kinh doanh: chỉ buổi ở trường mình phụ trách', async () => {
    await expect(make(item(), { ownsSchool: true }).findOne(1, { kind: 'own-schools', employeeId: 26 })).resolves.toBeDefined();
    await expect(make(item(), { ownsSchool: false }).findOne(1, { kind: 'own-schools', employeeId: 26 })).rejects.toThrow(NotFoundException);
  });
});
