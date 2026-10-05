import { Injectable } from '@nestjs/common';
import { hrToday, isEffectiveOn } from '../common/effective-date';
import { HrAccessRepository } from './hr-access.repository';
import { HrAccessService, HrGrant } from './hr-access.service';
import { HrPermission } from './hr-permission';

export interface MyHrPermissionView {
  code: HrPermission;
  scopes: Pick<HrGrant, 'scope' | 'scopeRefId' | 'source' | 'via'>[];
}

/**
 * Các API chỉ đọc về cấu hình phân quyền. Tách khỏi `HrAccessService` (bộ
 * máy quyết định) để phần quyết định giữ gọn và không lẫn logic hiển thị.
 */
@Injectable()
export class HrAccessQueryService {
  constructor(
    private readonly repo: HrAccessRepository,
    private readonly access: HrAccessService,
  ) {}

  /** Quyền của chính người gọi — FE dùng để ẩn/hiện UI, backend vẫn kiểm tra lại. */
  async myPermissions(accountId: number) {
    const on = hrToday();
    const grants = await this.access.getGrants(accountId, undefined, on);

    const byCode = new Map<HrPermission, MyHrPermissionView>();
    // Chọn tường minh trường trả ra: khoảng hiệu lực là dữ liệu nội bộ cho M1,
    // không mở rộng hình dạng response của /me.
    for (const { permission, scope, scopeRefId, source, via } of grants) {
      const view = byCode.get(permission) ?? { code: permission, scopes: [] };
      view.scopes.push({ scope, scopeRefId, source, via });
      byCode.set(permission, view);
    }

    return { accountId, on, permissions: [...byCode.values()] };
  }

  listPermissions() {
    return this.repo.listPermissions();
  }

  listRolePermissions() {
    return this.repo.listRolePermissions();
  }

  /**
   * Lịch sử cấp quyền riêng của một tài khoản. Gọi `assertCanAccess` TRƯỚC khi
   * đọc: tài khoản ngoài phạm vi nhận 404 giống hệt tài khoản không tồn tại.
   */
  async accountGrants(viewerId: number, accountId: number) {
    await this.access.assertCanAccess(viewerId, HrPermission.ACCESS_VIEW, {
      accountId,
    });

    const on = hrToday();
    const history = await this.repo.listAccountGrantHistory(accountId);
    return {
      accountId,
      on,
      grants: history.map((g) => ({
        id: g.id,
        permission: g.permissionCode,
        scope: g.scope,
        scopeRefId: g.scopeRefId,
        effectiveFrom: g.effectiveFrom,
        effectiveTo: g.effectiveTo,
        active: isEffectiveOn(g.effectiveFrom, g.effectiveTo, on),
        reason: g.reason,
        grantedBy: g.grantedBy,
        createdAt: g.createdAt,
        version: g.version,
      })),
    };
  }
}
