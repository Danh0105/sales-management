import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HrAccessService } from './hr-access.service';
import { HrPermission, HrScope } from './hr-permission';
import {
  HrAuthenticatedOnly,
  HrPermissionGuard,
  RequireHrPermission,
} from './hr-permission.guard';

class Handlers {
  @RequireHrPermission(HrPermission.ACCESS_VIEW)
  guarded() {}

  @HrAuthenticatedOnly()
  me() {}

  undeclared() {}
}

function context(handler: keyof Handlers, user?: { id?: number }) {
  const req: Record<string, unknown> = { user };
  const ctx = {
    getHandler: () => Handlers.prototype[handler],
    getClass: () => Handlers,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

describe('HrPermissionGuard', () => {
  const grant = {
    permission: HrPermission.ACCESS_VIEW,
    scope: HrScope.COMPANY,
    scopeRefId: null,
    source: 'role' as const,
    via: 'nhansu',
  };

  function guard(grants = [grant]) {
    const access = {
      getGrants: jest.fn(() => Promise.resolve(grants)),
    } as unknown as HrAccessService;
    return { guard: new HrPermissionGuard(new Reflector(), access), access };
  }

  it('có quyền → cho qua và gắn req.hrAccess', async () => {
    const { guard: g, access } = guard();
    const { ctx, req } = context('guarded', { id: 1 });
    await expect(g.canActivate(ctx)).resolves.toBe(true);
    expect(access.getGrants).toHaveBeenCalledWith(1, HrPermission.ACCESS_VIEW);
    expect(req.hrAccess).toEqual({
      accountId: 1,
      permission: HrPermission.ACCESS_VIEW,
      grants: [grant],
    });
  });

  it('không có quyền → 403', async () => {
    const { guard: g } = guard([]);
    await expect(
      g.canActivate(context('guarded', { id: 1 }).ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('endpoint quên khai báo quyền → 403 (fail-closed), không chạm DB', async () => {
    const { guard: g, access } = guard();
    await expect(
      g.canActivate(context('undeclared', { id: 1 }).ctx),
    ).rejects.toThrow('chưa khai báo quyền');
    expect(access.getGrants).not.toHaveBeenCalled();
  });

  it('@HrAuthenticatedOnly → chỉ cần đăng nhập', async () => {
    const { guard: g } = guard([]);
    const { ctx, req } = context('me', { id: 9 });
    await expect(g.canActivate(ctx)).resolves.toBe(true);
    expect(req.hrAccess).toEqual({
      accountId: 9,
      permission: null,
      grants: [],
    });
  });

  it('không có user (thiếu JwtAuthGuard) → 401', async () => {
    const { guard: g } = guard();
    await expect(
      g.canActivate(context('guarded', undefined).ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
