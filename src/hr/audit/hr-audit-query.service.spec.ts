import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Repository } from 'typeorm';
import { HrGrant } from '../access/hr-access.service';
import { HrPermission, HrScope } from '../access/hr-permission';
import { QueryHrAuditLogDto } from './dto/query-hr-audit-log.dto';
import { HrAuditLog } from './entities/hr-audit-log.entity';
import { HrAuditQueryService } from './hr-audit-query.service';

const grant = (scope: HrScope): HrGrant => ({
  permission: HrPermission.AUDIT_VIEW,
  scope,
  scopeRefId: null,
  source: 'role',
  via: 'nhansu',
});

function service() {
  const qb = {
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(() => Promise.resolve([[], 0])),
  };
  const repo = {
    createQueryBuilder: jest.fn(() => qb),
  } as unknown as Repository<HrAuditLog>;
  return { svc: new HrAuditQueryService(repo), qb };
}

describe('HrAuditQueryService', () => {
  it('COMPANY → đọc được, mặc định trang 1, 20 dòng, mới nhất trước', async () => {
    const { svc, qb } = service();
    await expect(svc.list([grant(HrScope.COMPANY)], {})).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
    });
    expect(qb.orderBy).toHaveBeenCalledWith('a.occurredAt', 'DESC');
    expect(qb.skip).toHaveBeenCalledWith(0);
    expect(qb.take).toHaveBeenCalledWith(20);
  });

  it.each([HrScope.SELF, HrScope.TEAM, HrScope.ORG_UNIT, HrScope.BRANCH])(
    'phạm vi %s → 403 (chưa lọc được theo tổ chức, fail-closed)',
    async (scope) => {
      const { svc, qb } = service();
      await expect(svc.list([grant(scope)], {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(qb.getManyAndCount).not.toHaveBeenCalled();
    },
  );

  it('from > to → 400', async () => {
    const { svc } = service();
    await expect(
      svc.list([grant(HrScope.COMPANY)], {
        from: '2026-09-25',
        to: '2026-09-01',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lọc theo ngày dùng giờ Việt Nam, tham số hoá (không nối chuỗi)', async () => {
    const { svc, qb } = service();
    await svc.list([grant(HrScope.COMPANY)], {
      from: '2026-09-01',
      to: '2026-09-25',
      entity: 'holiday',
      page: 3,
      limit: 10,
    });
    expect(qb.andWhere).toHaveBeenCalledWith('a.entity = :entity', {
      entity: 'holiday',
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('AT TIME ZONE :tz'),
      {
        from: '2026-09-01',
        tz: 'Asia/Ho_Chi_Minh',
      },
    );
    expect(qb.skip).toHaveBeenCalledWith(20);
  });
});

describe('QueryHrAuditLogDto', () => {
  const check = async (input: Record<string, unknown>) =>
    validate(plainToInstance(QueryHrAuditLogDto, input));

  it('chấp nhận query hợp lệ', async () => {
    await expect(
      check({
        entity: 'holiday',
        action: 'HOLIDAY_CREATE',
        from: '2026-09-01',
        limit: '50',
      }),
    ).resolves.toHaveLength(0);
  });

  it.each([
    [{ limit: '1000' }, 'limit'],
    [{ action: 'DROP_ALL' }, 'action'],
    [{ from: '01/09/2026' }, 'from'],
    [{ entity: "x' OR 1=1" }, 'entity'],
    [{ actorAccountId: 'abc' }, 'actorAccountId'],
  ])('từ chối %o', async (input, property) => {
    const errors = await check(input);
    expect(errors.map((e) => e.property)).toContain(property);
  });
});
