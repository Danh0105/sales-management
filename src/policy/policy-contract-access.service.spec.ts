import { ForbiddenException } from '@nestjs/common';
import { PolicyContractAccessService } from './policy-contract-access.service';

function queryBuilder(result: unknown = { id: 1 }) {
  const qb: any = {
    innerJoin: jest.fn(() => qb),
    leftJoin: jest.fn(() => qb),
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    select: jest.fn(() => qb),
    getOne: jest.fn().mockResolvedValue(result),
  };
  return qb;
}

describe('PolicyContractAccessService', () => {
  const fileName = '123e4567-e89b-12d3-a456-426614174000.pdf';

  it('giám đốc Long An bị ép theo province_id=7', async () => {
    const qb = queryBuilder();
    const service = new PolicyContractAccessService(
      {} as any,
      {} as any,
      {} as any,
      { createQueryBuilder: () => qb } as any,
    );

    await service.assertCanRead(
      { id: 91, roles: ['director_la'] },
      fileName,
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      'ward.province_id = :provinceId',
      { provinceId: 7 },
    );
  });

  it('nhân viên sales chỉ đọc hợp đồng của trường mình phụ trách', async () => {
    const qb = queryBuilder();
    const service = new PolicyContractAccessService(
      {} as any,
      {} as any,
      {} as any,
      { createQueryBuilder: () => qb } as any,
    );

    await service.assertCanRead({ id: 18, roles: ['sales'] }, fileName);
    expect(qb.andWhere).toHaveBeenCalledWith(
      'school.employee_id = :employeeId',
      { employeeId: 18 },
    );
  });

  it('không tìm thấy policy trong scope thì trả 403', async () => {
    const qb = queryBuilder(null);
    const service = new PolicyContractAccessService(
      {} as any,
      {} as any,
      {} as any,
      { createQueryBuilder: () => qb } as any,
    );

    await expect(
      service.assertCanRead({ id: 18, roles: ['sales'] }, fileName),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
