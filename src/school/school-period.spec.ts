import { BadRequestException, NotFoundException } from '@nestjs/common';

import { SchoolPeriodService } from './school-period.service';

function makeService(schoolExists = true) {
  const saved: any[] = [];
  const repo = {
    find: jest.fn().mockResolvedValue([
      {
        id: 1,
        schoolId: 10,
        periodNo: 1,
        startTime: '07:00:00',
        endTime: '07:45:00',
        label: null,
      },
    ]),
    create: jest.fn((data) => data),
    save: jest.fn(async (rows) => {
      saved.push(...(Array.isArray(rows) ? rows : [rows]));
      return rows;
    }),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  const service = new SchoolPeriodService(
    repo as any,
    { exist: jest.fn().mockResolvedValue(schoolExists) } as any,
    { transaction: jest.fn(async (work: any) => work({ getRepository: () => repo })) } as any,
  );

  return { service, repo, saved };
}

const period = (no: number, start: string, end: string) => ({
  periodNo: no,
  startTime: start,
  endTime: end,
});

describe('SchoolPeriodService — giờ tiết học theo trường', () => {
  it('trả giờ dạng HH:mm cho FE, không kèm giây', async () => {
    const { service } = makeService();

    const rows = await service.findBySchool(10);

    expect(rows[0]).toMatchObject({
      periodNo: 1,
      startTime: '07:00',
      endTime: '07:45',
    });
  });

  it('lưu được bảng tiết hợp lệ, giờ chuyển sang dạng DB', async () => {
    const { service, saved } = makeService();

    await service.replace(10, {
      periods: [period(1, '07:00', '07:45'), period(2, '07:50', '08:35')],
    });

    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({
      schoolId: 10,
      periodNo: 1,
      startTime: '07:00:00',
      endTime: '07:45:00',
    });
  });

  it('chặn dòng trùng số thứ tự, báo theo tên nhìn thấy trên lưới', async () => {
    const { service } = makeService();

    await expect(
      service.replace(10, {
        periods: [
          { ...period(1, '07:00', '07:45'), label: '1', session: 'SANG' as const },
          { ...period(1, '08:00', '08:45'), label: '2', session: 'SANG' as const },
        ],
      }),
    ).rejects.toThrow(/SÁNG · tiết 2 bị khai trùng số thứ tự/);
  });

  it('chặn giờ bắt đầu không nhỏ hơn giờ kết thúc', async () => {
    const { service } = makeService();

    await expect(
      service.replace(10, { periods: [period(1, '08:00', '07:00')] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('CHỒNG GIỜ vẫn lưu, chỉ trả cảnh báo — không huỷ cả lần lưu', async () => {
    const { service, saved } = makeService();

    const result: any = await service.replace(10, {
      periods: [
        { ...period(1, '07:00', '07:45'), label: '1', session: 'SANG' as const },
        { ...period(2, '07:30', '08:15'), label: '2', session: 'SANG' as const },
      ],
    });

    // Điểm mấu chốt: dữ liệu VẪN được ghi.
    expect(saved).toHaveLength(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/SÁNG · tiết 1 và SÁNG · tiết 2 bị chồng giờ/);
  });

  it('cảnh báo gọi đúng tên dòng ra chơi, không dùng số thứ tự nội bộ', async () => {
    const { service } = makeService();

    const result: any = await service.replace(10, {
      periods: [
        {
          ...period(8, '14:50', '15:30'),
          label: 'RA CHƠI',
          session: 'CHIEU' as const,
          isPeriod: false,
        },
        { ...period(9, '15:20', '16:00'), label: '3', session: 'CHIEU' as const },
      ],
    });

    expect(result.warnings[0]).toBe(
      'CHIỀU · RA CHƠI và CHIỀU · tiết 3 bị chồng giờ',
    );
  });

  it('cho phép lưu bảng rỗng (xoá hết tiết đã khai)', async () => {
    const { service, repo } = makeService();

    await service.replace(10, { periods: [] });

    expect(repo.delete).toHaveBeenCalledWith({ schoolId: 10 });
  });

  it('trường không tồn tại thì báo 404', async () => {
    const { service } = makeService(false);

    await expect(service.findBySchool(999)).rejects.toThrow(NotFoundException);
  });
});
