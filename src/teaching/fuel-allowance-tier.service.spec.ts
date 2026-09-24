import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  diagnoseGasAllowance,
  FuelAllowanceTierService,
  homeAtDate,
} from './fuel-allowance-tier.service';
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
    location?: any;
    /** Buổi đang trống phụ cấp mà `recomputeMissingGasAllowances` tìm ra. */
    missingSessions?: any[];
    sentPayrolls?: any[];
    /** Lịch sử đổi vị trí đã duyệt (TeacherLocationChange). */
    locationChanges?: any[];
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

    const locationRepo: any = {
      findOne: jest.fn().mockResolvedValue(overrides.location ?? null),
    };

    const sessionQb: any = {
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(overrides.missingSessions ?? []),
    };
    const sessionRepo: any = {
      createQueryBuilder: jest.fn().mockReturnValue(sessionQb),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const locationChangeRepo: any = {
      find: jest.fn().mockResolvedValue(overrides.locationChanges ?? []),
    };
    const payrollRepo: any = {
      find: jest.fn().mockResolvedValue(overrides.sentPayrolls ?? []),
    };

    const service = new FuelAllowanceTierService(
      tierRepo,
      teacherRepo,
      schoolRepo,
      employeeRepo,
      locationRepo,
      sessionRepo,
      payrollRepo,
      locationChangeRepo,
    );
    return {
      service,
      tierRepo,
      teacherRepo,
      employeeRepo,
      schoolRepo,
      locationRepo,
      sessionRepo,
      sessionQb,
      payrollRepo,
    };
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

    // `0, 0` là dữ liệu khai thiếu chứ không phải toạ độ giữa Đại Tây Dương:
    // tính thật ra ~11.800 km, vừa sai phụ cấp vừa làm vỡ cột numeric(6,2)
    // của buổi dạy khiến cả lịch dạy không sinh được buổi nào.
    it('trường khai toạ độ 0,0 → coi như chưa có toạ độ, không tính khoảng cách', async () => {
      const { service } = setup({ school: { id: 5, latitude: 0, longitude: 0 } });
      const result = await service.computeForTeacherSchool(1, 5);
      expect(result).toEqual({
        isCompanyTeacher: true,
        distanceToSchoolKm: null,
        gasAllowance: null,
      });
    });

    it('giáo viên khai toạ độ 0,0 → cũng coi như chưa có vị trí', async () => {
      const { service } = setup({
        teacher: { id: 1, employeeId: 100, latitude: 0, longitude: 0 },
      });
      const result = await service.computeForTeacherSchool(1, 5);
      expect(result).toEqual({
        isCompanyTeacher: true,
        distanceToSchoolKm: null,
        gasAllowance: null,
      });
    });

    it('điểm trường khai 0,0 → lùi về toạ độ trường mẹ thay vì đo tới 0,0', async () => {
      const { service } = setup({
        location: { id: 9, latitude: 0, longitude: 0 },
      });
      const result = await service.computeForTeacherSchool(1, 5, 9);
      expect(result.distanceToSchoolKm).toBeCloseTo(2.6, 0);
      expect(result.gasAllowance).toBe(20_000);
    });
  });

  describe('diagnoseGasAllowance() — báo đủ lý do thiếu phụ cấp', () => {
    const home = { latitude: 10.8, longitude: 106.7 };
    const school = { latitude: 10.82, longitude: 106.71 };

    it('đủ dữ liệu và khớp bậc → có phụ cấp, không lý do', () => {
      expect(diagnoseGasAllowance({ teacher: home, school, tiers: TIERS })).toMatchObject({
        gasAllowance: 20_000,
        missingReasons: [],
      });
    });

    it('thiếu cả nhà lẫn trường → báo cả hai, không dừng ở lý do đầu', () => {
      expect(
        diagnoseGasAllowance({
          teacher: { latitude: null, longitude: null },
          school: { latitude: 0, longitude: 0 },
          tiers: TIERS,
        }).missingReasons,
      ).toEqual(['NO_TEACHER_LOCATION', 'NO_SCHOOL_LOCATION']);
    });

    it('điểm trường chưa có toạ độ thì lùi về toạ độ trường', () => {
      expect(
        diagnoseGasAllowance({
          teacher: home,
          school,
          location: { latitude: null, longitude: null },
          tiers: TIERS,
        }).missingReasons,
      ).toEqual([]);
    });

    it('khoảng cách rơi vào khe giữa các bậc → NO_MATCHING_TIER kèm số km', () => {
      const result = diagnoseGasAllowance({
        teacher: home,
        school,
        tiers: [{ minDistanceKm: 8, maxDistanceKm: 12, amount: 25_000 }],
      });
      expect(result.missingReasons).toEqual(['NO_MATCHING_TIER']);
      expect(result.distanceToSchoolKm).toBeGreaterThan(0);
    });

    it('toạ độ số dạng chuỗi (raw query) vẫn tính đúng', () => {
      expect(
        diagnoseGasAllowance({
          teacher: { latitude: '10.8', longitude: '106.7' },
          school: { latitude: '10.82', longitude: '106.71' },
          tiers: TIERS,
        }).gasAllowance,
      ).toBe(20_000);
    });
  });

  describe('recomputeMissingGasAllowances() — điền phụ cấp cho buổi đang trống', () => {
    const session = (id: number, date: string, overrides: any = {}) => ({
      id,
      teacherId: 1,
      employeeId: 100,
      teacherName: 'Cô A',
      teacherLatitude: '10.8',
      teacherLongitude: '106.7',
      schoolId: 5,
      schoolName: 'TH A',
      schoolLatitude: '10.82',
      schoolLongitude: '106.71',
      schoolLocationId: null,
      locationName: null,
      locationLatitude: null,
      locationLongitude: null,
      date,
      ...overrides,
    });

    it('điền phụ cấp theo bậc cho các buổi đang trống, gộp theo điểm dạy', async () => {
      const { service, sessionRepo, sessionQb } = setup({
        missingSessions: [session(11, '2026-09-01'), session(12, '2026-09-02')],
      });

      const result = await service.recomputeMissingGasAllowances({ teacherId: 1 });

      expect(result).toMatchObject({ updated: 2, skippedLocked: 0, stillMissing: 0 });
      // Chỉ lấy buổi TRỐNG phụ cấp — buổi đã chốt là lịch sử, không đụng.
      expect(sessionQb.andWhere).toHaveBeenCalledWith('ss.gasAllowance IS NULL');
      expect(sessionQb.andWhere).toHaveBeenCalledWith('ss.teacherId = :teacherId', {
        teacherId: 1,
      });
      // Hai buổi cùng giáo viên + cùng trường → một lần update.
      expect(sessionRepo.update).toHaveBeenCalledTimes(1);
      const [where, values] = sessionRepo.update.mock.calls[0];
      expect(where.id.value).toEqual([11, 12]);
      expect(values.gasAllowance).toBe(20_000);
      expect(values.distanceToSchoolKm).toBeGreaterThan(0);
    });

    it('bỏ qua tháng đã gửi phiếu lương', async () => {
      const { service, sessionRepo } = setup({
        missingSessions: [session(11, '2026-08-20'), session(12, '2026-09-02')],
        sentPayrolls: [{ employeeId: 100, year: 2026, month: 8 }],
      });

      const result = await service.recomputeMissingGasAllowances();

      expect(result).toMatchObject({ updated: 1, skippedLocked: 1, stillMissing: 0 });
      expect(sessionRepo.update.mock.calls[0][0].id.value).toEqual([12]);
    });

    it('còn thiếu thì báo rõ: giáo viên nào thiếu vị trí, trường nào thiếu toạ độ', async () => {
      const { service, sessionRepo } = setup({
        missingSessions: [
          session(11, '2026-09-01', { teacherLatitude: null, teacherLongitude: null }),
          session(12, '2026-09-02', { teacherLatitude: null, teacherLongitude: null }),
          session(13, '2026-09-03', {
            teacherId: 2,
            teacherName: 'Thầy B',
            schoolId: 6,
            schoolName: 'TH B',
            schoolLatitude: null,
            schoolLongitude: null,
          }),
        ],
      });

      const result = await service.recomputeMissingGasAllowances();

      expect(sessionRepo.update).not.toHaveBeenCalled();
      expect(result.stillMissing).toBe(3);
      expect(result.missing.teachersWithoutLocation).toEqual([
        { teacherId: 1, teacherName: 'Cô A', sessions: 2 },
      ]);
      expect(result.missing.placesWithoutLocation).toEqual([
        expect.objectContaining({ schoolId: 6, schoolName: 'TH B', sessions: 1 }),
      ]);
    });

    it('không bậc nào khớp → báo khoảng cách để khai thêm bậc', async () => {
      const { service } = setup({
        tiers: [{ id: 1, minDistanceKm: 8, maxDistanceKm: 12, amount: 25_000 }],
        missingSessions: [session(11, '2026-09-01')],
      });

      const result = await service.recomputeMissingGasAllowances();

      expect(result.missing.distancesWithoutTier).toEqual([
        expect.objectContaining({
          teacherName: 'Cô A',
          schoolName: 'TH A',
          reason: 'NO_MATCHING_TIER',
          sessions: 1,
        }),
      ]);
    });

    it('thêm bậc mới thì tự chạy tính lại', async () => {
      const { service, sessionRepo } = setup({ tiers: [] });

      await service.create({ minDistanceKm: 0, maxDistanceKm: 50, amount: 40_000 });

      expect(sessionRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it('lỗi khi tính lại không làm hỏng thao tác lưu bậc', async () => {
      const { service, sessionRepo } = setup({ tiers: [] });
      sessionRepo.createQueryBuilder.mockImplementation(() => {
        throw new Error('db down');
      });

      await expect(
        service.create({ minDistanceKm: 0, maxDistanceKm: 50, amount: 40_000 }),
      ).resolves.toMatchObject({ amount: 40_000 });
    });
  });

  describe('homeAtDate() — vị trí nhà có hiệu lực từ ngày duyệt', () => {
    const current = { latitude: 10.9, longitude: 106.9 };
    const changes = [
      {
        effectiveDate: '2026-09-10',
        latitude: 10.8,
        longitude: 106.8,
        previousLatitude: 10.7,
        previousLongitude: 106.7,
      },
      {
        effectiveDate: '2026-09-20',
        latitude: 10.9,
        longitude: 106.9,
        previousLatitude: 10.8,
        previousLongitude: 106.8,
      },
    ];

    it('chưa từng đổi → vị trí hiện tại', () => {
      expect(homeAtDate([], current, '2026-09-01')).toBe(current);
    });

    it('trước lần duyệt đầu → nhà cũ trước lần đổi đó', () => {
      expect(homeAtDate(changes, current, '2026-09-09')).toEqual({
        latitude: 10.7,
        longitude: 106.7,
      });
    });

    it('từ đúng ngày duyệt → nhà mới (ngày duyệt được tính)', () => {
      expect(homeAtDate(changes, current, '2026-09-10')).toEqual({
        latitude: 10.8,
        longitude: 106.8,
      });
      expect(homeAtDate(changes, current, '2026-09-19')).toEqual({
        latitude: 10.8,
        longitude: 106.8,
      });
    });

    it('sau lần duyệt cuối → vị trí hiện tại trong hồ sơ', () => {
      expect(homeAtDate(changes, current, '2026-09-25')).toBe(current);
    });

    it('lần khai đầu tiên (chưa có nhà trước đó) → coi là nơi ở từ trước', () => {
      const first = [{ ...changes[0], previousLatitude: null, previousLongitude: null }];
      expect(homeAtDate(first, current, '2026-08-01')).toEqual({
        latitude: 10.8,
        longitude: 106.8,
      });
    });
  });

  describe('reapplyTeacherLocation() — áp vị trí mới từ ngày duyệt', () => {
    const session = (id: number, date: string, gasAllowance: any) => ({
      id,
      teacherId: 1,
      employeeId: 100,
      teacherName: 'Cô A',
      // Vị trí hiện tại = nhà mới, gần trường (≈ 2,5 km → bậc 20.000).
      teacherLatitude: '10.8',
      teacherLongitude: '106.7',
      schoolId: 5,
      schoolName: 'TH A',
      schoolLatitude: '10.82',
      schoolLongitude: '106.71',
      schoolLocationId: null,
      locationName: null,
      locationLatitude: null,
      locationLongitude: null,
      date,
      gasAllowance,
      distanceToSchoolKm: '12',
    });

    it('ghi đè cả buổi ĐÃ có phụ cấp, chỉ từ ngày hiệu lực trở đi', async () => {
      const { service, sessionRepo, sessionQb } = setup({
        // Hai buổi đã chốt 50.000 theo nhà cũ ở xa.
        missingSessions: [session(11, '2026-09-10', '50000'), session(12, '2026-09-11', '50000')],
      });

      const result = await service.reapplyTeacherLocation(1, '2026-09-10');

      expect(sessionQb.andWhere).toHaveBeenCalledWith('ss.date >= :fromDate', {
        fromDate: '2026-09-10',
      });
      // Không giới hạn ở buổi trống — buổi đã chốt theo nhà cũ cũng phải sửa.
      expect(sessionQb.andWhere).not.toHaveBeenCalledWith('ss.gasAllowance IS NULL');
      expect(result.updated).toBe(2);
      expect(sessionRepo.update.mock.calls[0][1].gasAllowance).toBe(20_000);
    });

    it('không đụng tháng đã gửi phiếu lương', async () => {
      const { service, sessionRepo } = setup({
        missingSessions: [session(11, '2026-09-10', '50000')],
        sentPayrolls: [{ employeeId: 100, year: 2026, month: 9 }],
      });

      const result = await service.reapplyTeacherLocation(1, '2026-09-10');

      expect(result).toMatchObject({ updated: 0, skippedLocked: 1 });
      expect(sessionRepo.update).not.toHaveBeenCalled();
    });

    it('buổi đã đúng số thì không ghi lại', async () => {
      const unchanged = { ...session(11, '2026-09-10', '20000') };
      const { service, sessionRepo } = setup({ missingSessions: [unchanged] });
      // Khoảng cách thật khớp đúng số đang lưu → không phải cập nhật.
      unchanged.distanceToSchoolKm = String(
        diagnoseGasAllowance({
          teacher: { latitude: '10.8', longitude: '106.7' },
          school: { latitude: '10.82', longitude: '106.71' },
          tiers: TIERS,
        }).distanceToSchoolKm,
      );

      const result = await service.reapplyTeacherLocation(1, '2026-09-10');

      expect(result.updated).toBe(0);
      expect(sessionRepo.update).not.toHaveBeenCalled();
    });

    it('buổi trống TRƯỚC ngày đổi nhà được điền theo nhà cũ, không theo nhà hiện tại', async () => {
      const { service, sessionRepo } = setup({
        missingSessions: [
          { ...session(11, '2026-09-05', null), distanceToSchoolKm: null },
          { ...session(12, '2026-09-15', null), distanceToSchoolKm: null },
        ],
        // Nhà cũ ở xa (≈ 13 km → bậc 50.000), duyệt nhà mới ngày 10/09.
        locationChanges: [
          {
            teacherId: 1,
            latitude: 10.8,
            longitude: 106.7,
            previousLatitude: 10.93,
            previousLongitude: 106.71,
            reviewedAt: new Date('2026-09-10T03:00:00Z'),
          },
        ],
      });

      await service.recomputeMissingGasAllowances({ teacherId: 1 });

      const updates = sessionRepo.update.mock.calls.map((call: any[]) => ({
        ids: call[0].id.value,
        gas: call[1].gasAllowance,
      }));
      expect(updates).toEqual(
        expect.arrayContaining([
          { ids: [11], gas: 50_000 },
          { ids: [12], gas: 20_000 },
        ]),
      );
    });
  });
});
