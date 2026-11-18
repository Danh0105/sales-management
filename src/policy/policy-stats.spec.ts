import type { Request } from 'express';
import { PolicyController } from './policy.controller';
import { PolicyService } from './policy.service';

const requestFor = (id: number, roles: string[]) =>
  ({ user: { id, name: 'Test', roles } }) as unknown as Request;

describe('PolicyController.getStats', () => {
  it('trả tổng hợp mọi nhân viên cho role xem toàn bộ khi không chọn nhân viên', async () => {
    const service = { getStats: jest.fn().mockResolvedValue([]) };
    const controller = new PolicyController(service as unknown as PolicyService);

    await controller.getStats({}, requestFor(1, ['director']));

    expect(service.getStats).toHaveBeenCalledWith(undefined, undefined, undefined);
  });

  it('luôn ép nhân viên thường về dữ liệu của chính mình', async () => {
    const service = { getStats: jest.fn().mockResolvedValue([]) };
    const controller = new PolicyController(service as unknown as PolicyService);

    await controller.getStats({ employeeId: 999 }, requestFor(22, ['sales']));

    expect(service.getStats).toHaveBeenCalledWith(22, undefined, undefined);
  });

  it('giới hạn role Long An trong tỉnh 7 khi tổng hợp nhân viên', async () => {
    const service = { getStats: jest.fn().mockResolvedValue([]) };
    const controller = new PolicyController(service as unknown as PolicyService);

    await controller.getStats({}, requestFor(3, ['director_la']));

    expect(service.getStats).toHaveBeenCalledWith(undefined, undefined, 7);
  });
});

describe('PolicyService.getStats', () => {
  const makeQueryBuilder = () => {
    const qb: Record<string, jest.Mock> = {};
    for (const method of [
      'innerJoin',
      'leftJoin',
      'select',
      'andWhere',
      'orderBy',
      'addOrderBy',
    ]) {
      qb[method] = jest.fn().mockReturnValue(qb);
    }
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    return qb;
  };

  it('không thêm điều kiện nhân viên ở chế độ tổng hợp', async () => {
    const qb = makeQueryBuilder();
    const service = Object.create(PolicyService.prototype) as PolicyService;
    (service as any).policyRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };

    await service.getStats(undefined, false);

    expect(qb.leftJoin).toHaveBeenCalledWith('s.employee', 'emp');
    expect(qb.andWhere).not.toHaveBeenCalledWith(
      's.employee_id = :employeeId',
      expect.anything(),
    );
    expect(qb.andWhere).toHaveBeenCalledWith('p.status = :status', {
      status: 'DIRECTOR_APPROVED',
    });
  });

  it('áp dụng đồng thời bộ lọc nhân viên và phạm vi tỉnh', async () => {
    const qb = makeQueryBuilder();
    const service = Object.create(PolicyService.prototype) as PolicyService;
    (service as any).policyRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };

    await service.getStats(42, false, 7);

    expect(qb.andWhere).toHaveBeenCalledWith('s.employee_id = :employeeId', {
      employeeId: 42,
    });
    expect(qb.andWhere).toHaveBeenCalledWith('pr.id = :provinceId', {
      provinceId: 7,
    });
  });
});
