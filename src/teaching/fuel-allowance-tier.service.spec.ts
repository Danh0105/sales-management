import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { FuelAllowanceTierService } from './fuel-allowance-tier.service';
import { TEACHER_STAFF_ROLE, TEACHER_COLLABORATOR_ROLE } from './teaching-roles';

/**
 * Phụ cấp xăng theo khoảng cách — chỉ áp dụng giáo viên công ty
 * (`giaovien_congty`), đã có vị trí, trường có toạ độ, và có bậc khớp.
 */
describe('FuelAllowanceTierService', () => {
  const TIERS = [
    { id: 1, minDistanceKm: 0, maxDistanceKm: 5, amount: 20_000 },
    { id: 2, minDistanceKm: 5, maxDistanceKm: 10, amount: 30_000 },
    { id: 3, minDistanceKm: 10, maxDistanceKm: null, amount: 50_000 },
  ];

  function setup(overrides: {
    tiers?: any[];
    teacher?: any;
    employee?: any;
    school?: any;
  } = {}) {
    const tiers = overrides.tiers ?? TIERS;
    const tierRepo: any = {
      find: jest.fn().mockResolvedValue(tiers),
      findOne: jest.fn((opts: any) =>
        Promise.resolve(tiers.find((t) => t.id === opts.where.id) ?? null),
      ),
      create: jest.fn((data: any) => data),
      save: jest.fn(async (data: any) => ({ id: 99, ...data })),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const teacherRepo: any = {
      findOne: jest.fn().mockResolvedValue(
        overrides.teacher === undefined
          ? { id: 1, employeeId: 100, latitude: 10.8, longitude: 106.7 }
          : overrides.teacher,
      ),
    };
    const employeeRepo: any = {
      findOne: jest.fn().mockResolvedValue(
        overrides.employee === undefined
          ? { id: 100, roles: [TEACHER_STAFF_ROLE] }
          : overrides.employee,
      ),
    };
    const schoolRepo: any = {
      findOne: jest.fn().mockResolvedValue(
        overrides.school === undefined
          ? { id: 5, latitude: 10.82, longitude: 106.71 }
          : overrides.school,
      ),
    };

    const service = new FuelAllowanceTierService(
      tierRepo,
      teacherRepo,
      schoolRepo,
      employeeRepo,
    );
    return { service, tierRepo, teacherRepo, employeeRepo, schoolRepo };
  }

  describe('create()/update() — chặn chồng khoảng cách', () => {
    it('tạo bậc mới lấp đúng khoảng trống, không chồng thì thành công', async () => {
      const { service, tierRepo } = setup({
        tiers: [{ id: 1, minDistanceKm: 0, maxDistanceKm: 5, amount: 20_000 }],
      });
      await service.create({ minDistanceKm: 5, maxDistanceKm: 10, amount: 30_000 });
      expect(tierRepo.save).toHaveBeenCalled();
    });

    it('tạo bậc chồng khoảng cách với bậc đã có → 409', async () => {
      const { service } = setup();
      await expect(
        service.create({ minDistanceKm: 3, maxDistanceKm: 8, amount: 25_000 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('bậc cuối không giới hạn trên vẫn chặn chồng với bậc mới sau nó', async () => {
      const { service } = setup();
      await expect(
        service.create({ minDistanceKm: 15, maxDistanceKm: null, amount: 60_000 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('min >= max → 400', async () => {
      const { service } = setup();
      await expect(
        service.create({ minDistanceKm: 20, maxDistanceKm: 10, amount: 1000 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update() không tự chồng với chính nó', async () => {
      const { service } = setup();
      await service.update(2, { amount: 35_000 });
      // Không ném lỗi nghĩa là loại trừ đúng bản ghi đang sửa khỏi kiểm tra chồng.
    });

    it('update() bậc không tồn tại → 404', async () => {
      const { service } = setup();
      await expect(service.update(999, { amount: 1000 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('computeForTeacherSchool()', () => {
    it('giáo viên công ty có vị trí, trường có toạ độ → tính đúng bậc theo khoảng cách', async () => {
      const { service } = setup();
      const result = await service.computeForTeacherSchool(1, 5);
      expect(result.isCompanyTeacher).toBe(true);
      expect(result.distanceToSchoolKm).not.toBeNull();
      expect(result.gasAllowance).toBe(20_000); // khoảng cách nhỏ, rơi vào bậc 0-5km
    });

    it('giáo viên cộng tác viên → không tính, kể cả có vị trí', async () => {
      const { service } = setup({
        employee: { id: 100, roles: [TEACHER_COLLABORATOR_ROLE] },
      });
      const result = await service.computeForTeacherSchool(1, 5);
      expect(result).toEqual({
        isCompanyTeacher: false,
        distanceToSchoolKm: null,
        gasAllowance: null,
      });
    });

    it('giáo viên công ty nhưng chưa có vị trí → vẫn báo isCompanyTeacher để nơi gọi bỏ rate, không tính được khoảng cách', async () => {
      const { service } = setup({
        teacher: { id: 1, employeeId: 100, latitude: null, longitude: null },
      });
      const result = await service.computeForTeacherSchool(1, 5);
      expect(result).toEqual({
        isCompanyTeacher: true,
        distanceToSchoolKm: null,
        gasAllowance: null,
      });
    });

    it('trường chưa có toạ độ → vẫn báo isCompanyTeacher, không tính được khoảng cách', async () => {
      const { service } = setup({ school: { id: 5, latitude: null, longitude: null } });
      const result = await service.computeForTeacherSchool(1, 5);
      expect(result).toEqual({
        isCompanyTeacher: true,
        distanceToSchoolKm: null,
        gasAllowance: null,
      });
    });

    it('giáo viên chưa có tài khoản (thuê ngoài) → không tính', async () => {
      const { service } = setup({ teacher: { id: 1, employeeId: null } });
      const result = await service.computeForTeacherSchool(1, 5);
      expect(result).toEqual({
        isCompanyTeacher: false,
        distanceToSchoolKm: null,
        gasAllowance: null,
      });
    });

    it('chưa gán giáo viên (teacherId rỗng) → không tính', async () => {
      const { service } = setup();
      const result = await service.computeForTeacherSchool(null, 5);
      expect(result).toEqual({
        isCompanyTeacher: false,
        distanceToSchoolKm: null,
        gasAllowance: null,
      });
    });

    it('khoảng cách vượt mọi bậc đã khai → gasAllowance null, vẫn trả về khoảng cách', async () => {
      const { service } = setup({
        tiers: [{ id: 1, minDistanceKm: 0, maxDistanceKm: 2, amount: 10_000 }],
      });
      const result = await service.computeForTeacherSchool(1, 5);
      expect(result.distanceToSchoolKm).not.toBeNull();
      expect(result.gasAllowance).toBeNull();
    });
  });
});
