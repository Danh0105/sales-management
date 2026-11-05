import { BadRequestException } from '@nestjs/common';
import { ManagementExpenseItemsService } from './management-expense-items.service';

const sibling = {
  id: 1,
  rowIndex: 0,
  studentCount: '10',
  monthsCount: '1',
  ql1UnitPrice: '1000',
  ql1Tax: '0',
  paidAmount: '0',
  otherCosts: [],
};

function makeService(existing: any) {
  const repo = (value: any) => ({
    find: jest.fn().mockResolvedValue(value),
    findOne: jest.fn().mockResolvedValue(value),
  });
  const items = {
    find: jest.fn().mockResolvedValue([sibling]),
    findOne: jest.fn().mockResolvedValue(existing),
  };
  const transaction = jest.fn().mockResolvedValue(1);
  const service = new ManagementExpenseItemsService(
    items as any,
    repo({ id: 9, school: { id: 5 }, finalized: false }) as any,
    repo({ id: 3, schoolId: 5 }) as any,
    repo(null) as any,
    { transaction } as any,
  );
  jest.spyOn(service as any, 'findOneWithOtherCosts').mockResolvedValue(null);
  return { service, transaction };
}

const user = { id: 1, name: 'KT', roles: ['accountant'] } as any;

describe('API từng dòng Chi Ngoài — giới hạn Đã chi', () => {
  it('create vượt tổng Chi ngoài → 400, không ghi', async () => {
    const { service, transaction } = makeService(null);
    await expect(
      service.create({ schoolExpenseId: 9, subjectId: 3, paidAmount: 10001 }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('create bằng đúng tổng Chi ngoài thì lưu được', async () => {
    const { service, transaction } = makeService(null);
    await service.create({ schoolExpenseId: 9, subjectId: 3, paidAmount: 10000 }, user);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('update vượt tổng Chi ngoài → 400, không ghi', async () => {
    const { service, transaction } = makeService({
      ...sibling,
      schoolExpense: { id: 9, school: { id: 5 }, finalized: false },
      subject: { id: 3, schoolId: 5 },
    });
    await expect(service.update(1, { paidAmount: 10001 }, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});
