import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from '../../type/auth-user.type';
import { HrAccessService, HrGrant } from './hr-access.service';
import { HrPermission } from './hr-permission';

export const HR_PERMISSION_KEY = 'hr:permission';
export const HR_AUTHENTICATED_ONLY_KEY = 'hr:authenticated-only';

/**
 * Endpoint cần quyền HR này ở BẤT KỲ phạm vi nào. Guard chỉ chặn thô; kiểm
 * tra từng đối tượng (IDOR) vẫn phải gọi `HrAccessService.assertCanAccess`
 * trong service sau khi đọc bản ghi.
 */
export const RequireHrPermission = (permission: HrPermission) =>
  SetMetadata(HR_PERMISSION_KEY, permission);

/** Endpoint chỉ cần đăng nhập (vd. "quyền của tôi") — phải khai báo tường minh. */
export const HrAuthenticatedOnly = () =>
  SetMetadata(HR_AUTHENTICATED_ONLY_KEY, true);

export interface HrRequestAccess {
  accountId: number;
  permission: HrPermission | null;
  grants: HrGrant[];
}

/**
 * Guard của mọi controller HR, chạy sau `JwtAuthGuard`.
 *
 * Fail-closed: endpoint không khai báo `@RequireHrPermission` hay
 * `@HrAuthenticatedOnly` bị từ chối — quên gắn quyền không được biến thành
 * "ai đăng nhập cũng vào được".
 */
@Injectable()
export class HrPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: HrAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: AuthUser; hrAccess?: HrRequestAccess }>();
    const accountId = req.user?.id;
    if (!accountId) throw new UnauthorizedException('Token không hợp lệ');

    const targets = [context.getHandler(), context.getClass()];
    const permission = this.reflector.getAllAndOverride<
      HrPermission | undefined
    >(HR_PERMISSION_KEY, targets);
    const authenticatedOnly = this.reflector.getAllAndOverride<
      boolean | undefined
    >(HR_AUTHENTICATED_ONLY_KEY, targets);

    if (!permission) {
      if (authenticatedOnly) {
        req.hrAccess = { accountId, permission: null, grants: [] };
        return true;
      }
      throw new ForbiddenException('Endpoint HR chưa khai báo quyền');
    }

    const grants = await this.access.getGrants(accountId, permission);
    if (!grants.length) {
      throw new ForbiddenException('Bạn không có quyền truy cập chức năng này');
    }

    req.hrAccess = { accountId, permission, grants };
    return true;
  }
}
