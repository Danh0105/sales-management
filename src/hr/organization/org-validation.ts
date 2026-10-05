import {
  leaderRoleAllowed,
  OrgLeaderRole,
  parentTypeAllowed,
} from './org-policy';
import { OrgNode, OrgSnapshot } from './org-tree';

export interface OrgViolation {
  code: string;
  message: string;
}

/**
 * Kiểm tra một đơn vị (mới hoặc revision mới) có hợp lệ trong cơ cấu tại
 * ngày của snapshot không. Snapshot phải ĐÃ chứa `candidate` (withNode).
 */
export function structureViolation(
  snapshot: OrgSnapshot,
  candidate: OrgNode,
): OrgViolation | null {
  const at = snapshot.asOf;
  if (candidate.unitType === 'COMPANY') {
    if (candidate.parentId !== null) {
      return {
        code: 'HR_ORG_PARENT_TYPE',
        message: 'Công ty không có đơn vị cha',
      };
    }
    if (
      candidate.status === 'ACTIVE' &&
      snapshot.activeCompanies(candidate.id).length
    ) {
      return {
        code: 'HR_ORG_COMPANY_EXISTS',
        message: `Đã có một công ty đang hoạt động tại ngày ${at}`,
      };
    }
  } else {
    if (candidate.parentId === null) {
      return {
        code: 'HR_ORG_PARENT_REQUIRED',
        message: 'Đơn vị phải có đơn vị cha',
      };
    }
    const parent = snapshot.get(candidate.parentId);
    if (!parent) {
      return {
        code: 'HR_ORG_PARENT_NOT_FOUND',
        message: `Đơn vị cha chưa tồn tại tại ngày ${at}`,
      };
    }
    if (!parentTypeAllowed(candidate.unitType, parent.unitType)) {
      return {
        code: 'HR_ORG_PARENT_TYPE',
        message: `${candidate.unitType} không thể nằm dưới ${parent.unitType}`,
      };
    }
    if (candidate.status === 'ACTIVE' && parent.status !== 'ACTIVE') {
      return {
        code: 'HR_ORG_PARENT_INACTIVE',
        message: `Đơn vị cha đã ngừng hoạt động tại ngày ${at}`,
      };
    }
    if (
      candidate.id > 0 &&
      snapshot.wouldCycle(candidate.id, candidate.parentId)
    ) {
      return {
        code: 'HR_ORG_CYCLE',
        message: 'Không thể đặt đơn vị dưới chính đơn vị con của nó',
      };
    }
  }

  for (const child of snapshot.children(candidate.id)) {
    if (child.status !== 'ACTIVE') continue;
    if (candidate.status === 'INACTIVE') {
      return {
        code: 'HR_ORG_HAS_ACTIVE_CHILDREN',
        message: `Đơn vị còn đơn vị con đang hoạt động tại ngày ${at} — chuyển hoặc đóng đơn vị con trước`,
      };
    }
    if (!parentTypeAllowed(child.unitType, candidate.unitType)) {
      return {
        code: 'HR_ORG_CHILD_TYPE',
        message: `Đơn vị con ${child.code} (${child.unitType}) không thể nằm dưới ${candidate.unitType}`,
      };
    }
  }
  return null;
}

/** Vai trò lãnh đạo có hợp lệ với đơn vị tại ngày của snapshot không. */
export function leaderViolation(
  snapshot: OrgSnapshot,
  orgUnitId: number,
  role: OrgLeaderRole,
): OrgViolation | null {
  const unit = snapshot.get(orgUnitId);
  if (!unit || unit.status !== 'ACTIVE') {
    return {
      code: 'HR_ORG_UNIT_INACTIVE',
      message: `Đơn vị không hoạt động tại ngày ${snapshot.asOf}`,
    };
  }
  if (!leaderRoleAllowed(role, unit.unitType)) {
    return {
      code: 'HR_ORG_LEADER_ROLE',
      message: `Vai trò ${role} không áp dụng cho đơn vị loại ${unit.unitType}`,
    };
  }
  return null;
}
