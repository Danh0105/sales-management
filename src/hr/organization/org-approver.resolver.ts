import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  HR_APPROVER_NOT_CONFIGURED,
  OrgLeaderRole,
  OrgUnitType,
} from './org-policy';
import { OrgStructureRepository } from './org-structure.repository';

/**
 * Loại người duyệt resolve từ cơ cấu tổ chức (không bao giờ từ role cũ
 * `director`). `DIRECT_MANAGER` thuộc lịch sử công tác (Phase 1.4).
 */
export type OrgApproverKind =
  | 'DEPARTMENT_HEAD'
  | 'BRANCH_DIRECTOR'
  | 'COMPANY_DIRECTOR';

const TARGET: Record<
  OrgApproverKind,
  { types: OrgUnitType[]; role: OrgLeaderRole; missing: string }
> = {
  DEPARTMENT_HEAD: {
    types: ['DEPARTMENT', 'TEAM'],
    role: 'DEPARTMENT_HEAD',
    missing:
      'Đơn vị chưa cấu hình trưởng đơn vị phê duyệt. Vui lòng liên hệ HR.',
  },
  BRANCH_DIRECTOR: {
    types: ['BRANCH'],
    role: 'BRANCH_DIRECTOR',
    missing: 'Chi nhánh chưa cấu hình Giám đốc phê duyệt. Vui lòng liên hệ HR.',
  },
  COMPANY_DIRECTOR: {
    types: ['COMPANY'],
    role: 'COMPANY_DIRECTOR',
    missing: 'Công ty chưa cấu hình Giám đốc phê duyệt. Vui lòng liên hệ HR.',
  },
};

export interface ResolvedApprover {
  kind: OrgApproverKind;
  orgUnitId: number;
  leaderId: number;
  employeeId: number;
  employeeName: string;
}

export function approverNotConfigured(kind: OrgApproverKind, reason?: string) {
  return new UnprocessableEntityException({
    statusCode: 422,
    code: HR_APPROVER_NOT_CONFIGURED,
    approverKind: kind,
    message: reason ?? TARGET[kind].missing,
  });
}

/**
 * Resolve người duyệt tại một ngày: đơn vị gần nhất (gồm chính nó) đúng loại →
 * lãnh đạo có `is_approval_authority` đúng vai trò → nhân viên đang ACTIVE.
 * Thiếu bất kỳ bước nào → `HR_APPROVER_NOT_CONFIGURED` (fail closed).
 * Workflow (Phase 3) snapshot kết quả vào bước duyệt lúc nộp đơn.
 */
@Injectable()
export class OrgApproverResolver {
  constructor(private readonly repo: OrgStructureRepository) {}

  async resolve(
    manager: EntityManager,
    orgUnitId: number,
    kind: OrgApproverKind,
    asOf: string,
  ): Promise<ResolvedApprover> {
    const target = TARGET[kind];
    const snapshot = await this.repo.snapshot(manager, asOf);
    const self = snapshot.get(orgUnitId);
    if (!self || self.status !== 'ACTIVE') {
      throw approverNotConfigured(
        kind,
        `Đơn vị không hoạt động tại ngày ${asOf}. Vui lòng liên hệ HR.`,
      );
    }
    const unit = snapshot.nearest(orgUnitId, target.types);
    if (!unit || unit.status !== 'ACTIVE') throw approverNotConfigured(kind);

    const leaders = (
      await this.repo.leadersAt(manager, asOf, [unit.id])
    ).filter((l) => l.leaderRole === target.role && l.isApprovalAuthority);
    // Service đã chặn >1 người duyệt chính cùng lúc; nếu dữ liệu vẫn lệch thì không đoán.
    if (leaders.length !== 1 || leaders[0].employeeStatus !== 'ACTIVE') {
      throw approverNotConfigured(kind);
    }
    return {
      kind,
      orgUnitId: unit.id,
      leaderId: leaders[0].id,
      employeeId: leaders[0].employeeId,
      employeeName: leaders[0].employeeName,
    };
  }

  /** Xem trước cả ba loại cho một đơn vị — không ném lỗi. */
  async preview(manager: EntityManager, orgUnitId: number, asOf: string) {
    const kinds: OrgApproverKind[] = [
      'DEPARTMENT_HEAD',
      'BRANCH_DIRECTOR',
      'COMPANY_DIRECTOR',
    ];
    const out: (
      | {
          kind: OrgApproverKind;
          status: 'RESOLVED';
          approver: ResolvedApprover;
        }
      | {
          kind: OrgApproverKind;
          status: 'NOT_CONFIGURED';
          code: string;
          message: string;
        }
    )[] = [];
    for (const kind of kinds) {
      try {
        out.push({
          kind,
          status: 'RESOLVED' as const,
          approver: await this.resolve(manager, orgUnitId, kind, asOf),
        });
      } catch (error) {
        const body = (error as UnprocessableEntityException).getResponse?.() as
          | { message?: string }
          | undefined;
        out.push({
          kind,
          status: 'NOT_CONFIGURED' as const,
          code: HR_APPROVER_NOT_CONFIGURED,
          message: body?.message ?? '',
        });
      }
    }
    return { orgUnitId, asOf, approvers: out };
  }
}
