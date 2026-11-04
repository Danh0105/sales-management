import { NotificationService } from './notification.service';

function senderQuery(senderIsLongAnSales: boolean) {
  const qb: any = {
    innerJoin: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    getExists: jest.fn().mockResolvedValue(senderIsLongAnSales),
  };
  for (const method of ['innerJoin', 'where', 'andWhere']) {
    qb[method].mockReturnValue(qb);
  }
  return qb;
}

function makeService(senderIsLongAnSales: boolean) {
  const employeeRepo = {
    find: jest.fn().mockResolvedValue([
      { id: 1, roles: ['director_la'] },
      { id: 2, roles: ['director_la', 'director'] },
      { id: 3, roles: ['director'] },
    ]),
    createQueryBuilder: jest
      .fn()
      .mockReturnValue(senderQuery(senderIsLongAnSales)),
  };
  return new NotificationService(
    {} as any,
    {} as any,
    employeeRepo as any,
    {} as any,
  );
}

describe('NotificationService — phạm vi Giám đốc Long An', () => {
  it('giữ thông báo cho director_la khi người gửi là sales Long An', async () => {
    const service = makeService(true);

    await expect(service.scopeBusinessReceiverIds([1, 2, 3], 99)).resolves.toEqual([
      1,
      2,
      3,
    ]);
  });

  it('loại director_la khi người gửi không phải sales Long An', async () => {
    const service = makeService(false);

    await expect(service.scopeBusinessReceiverIds([1, 2, 3], 99)).resolves.toEqual([
      2,
      3,
    ]);
  });

  it('loại director_la với thông báo hệ thống không có người gửi', async () => {
    const service = makeService(false);

    await expect(service.scopeBusinessReceiverIds([1, 2, 3])).resolves.toEqual([
      2,
      3,
    ]);
  });
});
