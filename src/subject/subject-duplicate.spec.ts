import { ConflictException } from '@nestjs/common';
import { SubjectsService } from './subject.service';

/**
 * Mỗi trường trong một năm học chỉ có 1 môn cùng tên — kinh doanh tạo trùng
 * thì báo lỗi rõ ràng thay vì sinh môn thứ hai (chính sách một nơi, lịch dạy
 * một nơi).
 */
describe('SubjectsService chặn môn trùng tên trong cùng trường + năm học', () => {
  function setup(existing: any = null, current: any = null) {
    const where: string[] = [];
    const qb: any = {
      where: jest.fn((sql: string) => (where.push(sql), qb)),
      andWhere: jest.fn((sql: any) => (where.push(String(sql?.whereFactory ? 'brackets' : sql)), qb)),
      getOne: jest.fn().mockResolvedValue(existing),
    };
    const subjectRepo: any = {
      createQueryBuilder: jest.fn(() => qb),
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => ({ id: 99, ...x })),
      update: jest.fn(),
      findOne: jest.fn().mockResolvedValue(current),
    };
    const schoolRepo: any = {
      findOne: jest.fn().mockResolvedValue({ id: 10 }),
    };
    const catalogService: any = {
      resolveForSubject: jest
        .fn()
        .mockResolvedValue({ id: 6, name: 'Kỹ năng sống', isActive: true }),
    };
    const service = new SubjectsService(
      subjectRepo,
      schoolRepo,
      {} as any,
      {} as any,
      {} as any,
      catalogService,
      {} as any,
    );
    return { service, subjectRepo, where };
  }

  it('báo lỗi kèm tên môn + năm học khi trường đã có môn đó', async () => {
    const { service, subjectRepo } = setup({ id: 5, name: 'Kỹ năng sống' });

    const err = await service
      .create({ schoolId: 10, catalogId: 6, schoolYear: '2026-2027' } as any)
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toContain('Kỹ năng sống');
    expect(err.message).toContain('2026-2027');
    expect(subjectRepo.save).not.toHaveBeenCalled();
  });

  it('chỉ so trong đúng năm học của môn sắp tạo', async () => {
    const { service, subjectRepo, where } = setup(null);

    await service.create({
      schoolId: 10,
      catalogId: 6,
      schoolYear: '2026-2027',
    } as any);

    expect(where).toContain('subject.school_year = :schoolYear');
    expect(subjectRepo.save).toHaveBeenCalledTimes(1);
  });

  it('sửa số học sinh không bị chặn dù không đổi môn', async () => {
    const current = {
      id: 7,
      name: 'Kỹ năng sống',
      schoolId: 10,
      schoolYear: '2026-2027',
      catalogId: 6,
    };
    const { service, subjectRepo } = setup({ id: 8, name: 'Kỹ năng sống' }, current);

    await service.update(7, {
      schoolId: 10,
      schoolYear: '2026-2027',
      studentCount: 500,
    } as any);

    expect(subjectRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(subjectRepo.save).toHaveBeenCalledTimes(1);
  });

  it('đổi năm học sang năm đã có môn đó thì bị chặn, bỏ qua chính nó', async () => {
    const current = {
      id: 7,
      name: 'Kỹ năng sống',
      schoolId: 10,
      schoolYear: '2025-2026',
      catalogId: 6,
    };
    const { service, subjectRepo, where } = setup({ id: 8, name: 'Kỹ năng sống' }, current);

    await expect(
      service.update(7, { schoolId: 10, schoolYear: '2026-2027' } as any),
    ).rejects.toThrow(ConflictException);

    expect(where).toContain('subject.id <> :excludeId');
    expect(subjectRepo.save).not.toHaveBeenCalled();
  });
});
