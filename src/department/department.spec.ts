import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { ROLES_KEY } from '../auth/roles.decorator';
import {
  DEPARTMENT_ADMIN_ROLES,
  DepartmentController,
} from './department.controller';
import { DepartmentService } from './department.service';

const proto = DepartmentController.prototype;
const rolesOf = (handler: (...args: any[]) => unknown) =>
  Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined;

describe('DepartmentController — quyền', () => {
  it('mọi API phòng ban cần đăng nhập', () => {
    expect(Reflect.getMetadata('__guards__', DepartmentController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
  });

  it('thêm/sửa/xoá chỉ giám đốc, xem thì ai đăng nhập cũng được', () => {
    expect(rolesOf(proto.create)).toEqual(DEPARTMENT_ADMIN_ROLES);
    expect(rolesOf(proto.update)).toEqual(DEPARTMENT_ADMIN_ROLES);
    expect(rolesOf(proto.remove)).toEqual(DEPARTMENT_ADMIN_ROLES);
    expect(rolesOf(proto.findAll)).toBeUndefined();
    expect(rolesOf(proto.findOne)).toBeUndefined();
  });

  it('nhân viên thường không xoá được phòng ban', () => {
    const guard = new RolesGuard(new Reflector());
    const context = (roles: string[]) =>
      ({
        getHandler: () => proto.remove,
        getClass: () => DepartmentController,
        switchToHttp: () => ({ getRequest: () => ({ user: { roles } }) }),
      }) as any;

    expect(guard.canActivate(context(['sales']))).toBe(false);
    expect(guard.canActivate(context(['director']))).toBe(true);
  });
});

describe('DepartmentService — không trả danh sách nhân viên', () => {
  const repo = {
    find: jest.fn().mockResolvedValue([{ id: 1, name: 'Kinh doanh' }]),
    findOne: jest.fn().mockResolvedValue({ id: 1, name: 'Kinh doanh' }),
  };
  const service = new DepartmentService(repo as any);

  it('findAll / findOne không nạp quan hệ employees', async () => {
    await service.findAll();
    await service.findOne(1);

    expect(repo.find.mock.calls[0][0]).not.toHaveProperty('relations');
    expect(repo.findOne.mock.calls[0][0]).not.toHaveProperty('relations');
  });
});
