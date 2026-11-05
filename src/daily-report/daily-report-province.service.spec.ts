import { BadRequestException } from '@nestjs/common';
import { DailyReportProvinceService } from './daily-report-province.service';

describe('DailyReportProvinceService', () => {
  it('ưu tiên trường thực tế và chấp nhận nhân viên kiêm tỉnh', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([{ id: 501, province_id: 7 }]),
    };
    const service = new DailyReportProvinceService(dataSource as any);

    await expect(
      service.resolve(18, { schoolId: 501, tasks: [] }),
    ).resolves.toEqual({ provinceId: 7, schoolId: 501 });
  });

  it('GPS gần trường Long An đưa đúng báo cáo đa tỉnh vào Long An', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ province_id: 7, distance_m: 25 }]),
    };
    const service = new DailyReportProvinceService(dataSource as any);

    await expect(
      service.resolve(28, {
        tasks: [{ location: '10.695, 106.243' }],
      }),
    ).resolves.toEqual({ provinceId: 7, schoolId: null });
  });

  it('nhân viên đa tỉnh không có trường/GPS thì không tự gán Long An', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        { province_id: 7 },
        { province_id: 8 },
      ]),
    };
    const service = new DailyReportProvinceService(dataSource as any);

    await expect(service.resolve(126, { tasks: [] })).resolves.toEqual({
      provinceId: null,
      schoolId: null,
    });
  });

  it('nhân viên chỉ có Long An dùng tỉnh duy nhất làm fallback', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([{ province_id: 7 }]),
    };
    const service = new DailyReportProvinceService(dataSource as any);

    await expect(service.resolve(87, { tasks: [] })).resolves.toEqual({
      provinceId: 7,
      schoolId: null,
    });
  });

  it('không cho khai trường ngoài phạm vi nhân viên', async () => {
    const dataSource = { query: jest.fn().mockResolvedValue([]) };
    const service = new DailyReportProvinceService(dataSource as any);

    await expect(
      service.resolve(18, { schoolId: 999, tasks: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
