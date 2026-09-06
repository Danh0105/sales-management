import { NotFoundException } from '@nestjs/common';
import { SubjectsService } from './subject.service';

/**
 * Áp cùng một đơn giá cho nhiều môn học (nhiều trường dạy cùng môn) trong một
 * lần gọi — thay cho việc Nhân sự phải sửa từng trường một khi các trường
 * thoả cùng một mức giá.
 */
describe('SubjectsService.bulkUpdateRate', () => {
  function setup(affected = 2) {
    const updatedRows = [
      { id: 1, schoolId: 10, ratePerPeriod: 150000 },
      { id: 2, schoolId: 11, ratePerPeriod: 150000 },
    ];
    const subjectRepo: any = {
      update: jest.fn().mockResolvedValue({ affected }),
      find: jest.fn().mockResolvedValue(updatedRows),
    };
    const service = new SubjectsService(
      subjectRepo,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, subjectRepo };
  }

  it('cập nhật đơn giá cho đúng danh sách môn đã chọn, bỏ id trùng', async () => {
    const { service, subjectRepo } = setup();

    const result = await service.bulkUpdateRate([1, 2, 2], 150000);

    expect(subjectRepo.update).toHaveBeenCalledTimes(1);
    const [criteria, patch] = subjectRepo.update.mock.calls[0];
    expect(patch).toEqual({ ratePerPeriod: 150000 });
    expect(criteria.id.value).toEqual([1, 2]);
    expect(result).toHaveLength(2);
  });

  it('không có môn nào khớp thì báo lỗi 404 thay vì trả mảng rỗng im lặng', async () => {
    const { service } = setup(0);

    await expect(service.bulkUpdateRate([999], 100000)).rejects.toThrow(
      NotFoundException,
    );
  });
});
