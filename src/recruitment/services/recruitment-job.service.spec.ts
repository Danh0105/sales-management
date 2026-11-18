import {
  RecruitmentActorType,
  RecruitmentJobStatus,
} from '../recruitment.enums';
import { RecruitmentJobService } from './recruitment-job.service';

describe('RecruitmentJobService — form vị trí v2', () => {
  const actor = {
    type: RecruitmentActorType.HR,
    employeeId: 7,
    name: 'HR KIDO',
    roles: ['nhansu'],
  };
  let persisted: any;
  let jobRepo: any;
  let departmentRepo: any;
  let provinceRepo: any;
  let wardRepo: any;
  let employeeRepo: any;
  let audit: any;
  let service: RecruitmentJobService;

  beforeEach(() => {
    persisted = null;
    jobRepo = {
      create: jest.fn((value) => ({ ...value })),
      save: jest.fn(async (value) => {
        persisted = { id: value.id ?? 10, ...value };
        return persisted;
      }),
      findOne: jest.fn(async () => persisted),
      exists: jest.fn().mockResolvedValue(false),
    };
    departmentRepo = {
      exists: jest.fn().mockResolvedValue(true),
      countBy: jest.fn().mockResolvedValue(1),
    };
    provinceRepo = {
      findBy: jest.fn().mockResolvedValue([{ id: 1, name: 'TP.HCM' }]),
    };
    wardRepo = {
      findBy: jest
        .fn()
        .mockResolvedValue([
          { id: 2, name: 'Phường Bến Nghé', province_id: 1 },
        ]),
    };
    employeeRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 7,
        name: 'HR KIDO',
        email: 'hr@kido.vn',
        phone: '0901234567',
      }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new RecruitmentJobService(
      jobRepo,
      departmentRepo,
      provinceRepo,
      wardRepo,
      employeeRepo,
      audit,
    );
  });

  it('chuẩn hoá địa điểm, tự điền liên hệ và sanitize rich text khi tạo', async () => {
    const result = await service.create(
      {
        positionRole: 'sales',
        code: 'SALES-01',
        title: 'Nhân viên kinh doanh',
        departmentId: 5,
        industryIds: [5],
        description:
          '<script>alert(1)</script><p onclick="x()"><strong>Bán hàng</strong></p>',
        salaryNegotiable: true,
        salaryMin: 1,
        salaryMax: 2,
        workLocations: [{ provinceId: 1, wardId: 2, address: '12 Lê Lợi' }],
      },
      actor,
    );

    expect(jobRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        salaryMin: null,
        salaryMax: null,
        salaryNegotiable: true,
        contactName: 'HR KIDO',
        contactEmail: 'hr@kido.vn',
        contactPhone: '0901234567',
        description: '<p><strong>Bán hàng</strong></p>',
        location: '12 Lê Lợi, Phường Bến Nghé, TP.HCM',
        workLocations: [
          {
            provinceId: 1,
            provinceName: 'TP.HCM',
            wardId: 2,
            wardName: 'Phường Bến Nghé',
            address: '12 Lê Lợi',
          },
        ],
      }),
    );
    expect(result.id).toBe(10);
  });

  it('không cho công bố form v2 còn thiếu dữ liệu bắt buộc', async () => {
    persisted = {
      id: 10,
      code: 'SALES-01',
      title: 'Sales',
      status: RecruitmentJobStatus.DRAFT,
      formVersion: 2,
      industryIds: [],
      workLocations: [],
      numberOfPositions: 1,
    };

    await expect(service.publish(10, actor)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'JOB_INCOMPLETE',
        missingFields: expect.arrayContaining([
          'industryIds',
          'description',
          'workLocations',
          'contactEmail',
        ]),
      }),
    });
    expect(jobRepo.save).not.toHaveBeenCalled();
  });

  it('giữ workflow công bố cho bản ghi v1 để tương thích dữ liệu cũ', async () => {
    persisted = {
      id: 9,
      code: 'LEGACY-01',
      title: 'Vị trí cũ',
      status: RecruitmentJobStatus.DRAFT,
      formVersion: 1,
      publishedAt: null,
    };

    const result = await service.publish(9, actor);

    expect(jobRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: RecruitmentJobStatus.ACTIVE }),
    );
    expect(result.status).toBe(RecruitmentJobStatus.ACTIVE);
  });
});
