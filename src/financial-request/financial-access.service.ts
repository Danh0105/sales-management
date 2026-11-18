import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, IsNull, Repository, SelectQueryBuilder } from 'typeorm';

import { Employee } from '../employee/employee.entity';
import { DEPARTMENT_HEAD_ROLES } from '../employee/employee-positions';
import { AuthUser } from '../type/auth-user.type';
import { FinancialApprovalDelegation } from './entities/financial-approval-delegation.entity';
import { FinancialApprovalStep } from './entities/financial-approval-step.entity';
import { FinancialRequest } from './entities/financial-request.entity';
import { FinancialRoleAssignment } from './entities/financial-role-assignment.entity';
import {
  ApprovalStatus,
  ApproverType,
  DIRECT_MANAGER_SYSTEM_ROLES,
  FINANCE_CONFIG_SYSTEM_ROLES,
  FinanceRole,
  FinancialRequestType,
  IMPLICIT_FINANCE_ROLES,
  PAYROLL_DEDUCTION_SYSTEM_ROLES,
  SelfApprovalMode,
  StepStatus,
} from './financial-request.constants';

/** Phạm vi một vai trò: NULL = mọi công ty / mọi phòng ban. */
export interface RoleScope {
  role: FinanceRole;
  companyId: number | null;
  departmentId: number | null;
  approvalLimit: number | null;
}

export interface ActiveDelegation {
  delegatorId: number;
  companyId: number | null;
  requestType: FinancialRequestType | null;
}

export interface FinanceContext {
  userId: number;
  name: string;
  systemRoles: string[];
  scopes: RoleScope[];
  /** Quản trị toàn phân hệ (cấu hình, xem mọi phiếu). */
  isAdmin: boolean;
  delegations: ActiveDelegation[];
}

/** Vai trò nào thì được xem phiếu trong phạm vi của mình. */
const VIEW_ROLES = [
  FinanceRole.MANAGER,
  FinanceRole.CONTROLLER,
  FinanceRole.ACCOUNTANT,
  FinanceRole.CASHIER,
  FinanceRole.DIRECTOR,
  FinanceRole.ADMIN,
  FinanceRole.VIEWER,
];

type ScopedRequest = Pick<
  FinancialRequest,
  'companyId' | 'departmentId' | 'requesterId' | 'createdById'
> &
  Partial<Pick<FinancialRequest, 'directManagerId' | 'type' | 'id'>>;

const covers = (
  scope: RoleScope,
  companyId: number | null | undefined,
  departmentId: number | null | undefined,
) =>
  (scope.companyId === null || scope.companyId === companyId) &&
  (scope.departmentId === null || scope.departmentId === departmentId);

@Injectable()
export class FinancialAccessService {
  constructor(
    @InjectRepository(FinancialRoleAssignment)
    private readonly assignmentRepo: Repository<FinancialRoleAssignment>,
    @InjectRepository(FinancialApprovalDelegation)
    private readonly delegationRepo: Repository<FinancialApprovalDelegation>,
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
  ) {}

  /** Nạp quyền tài chính của người đang đăng nhập — gọi đầu mỗi request. */
  async context(user: AuthUser): Promise<FinanceContext> {
    const userId = Number(user?.id);
    if (!userId) throw new ForbiddenException('Chưa đăng nhập');
    const systemRoles = user.roles ?? [];

    const implicit: RoleScope[] = systemRoles.flatMap((role) =>
      (IMPLICIT_FINANCE_ROLES[role] ?? []).map((financeRole) => ({
        role: financeRole,
        companyId: null,
        departmentId: null,
        approvalLimit: null,
      })),
    );
    const assignments = await this.assignmentRepo.find({
      where: { employeeId: userId, isActive: true },
    });
    const scopes = [
      ...implicit,
      ...assignments.map((a) => ({
        role: a.role,
        companyId: a.companyId,
        departmentId: a.departmentId,
        approvalLimit: a.approvalLimit,
      })),
    ];

    const now = new Date();
    const delegations = await this.delegationRepo
      .createQueryBuilder('d')
      .where('d.delegate_id = :userId', { userId })
      .andWhere('d.revoked_at IS NULL')
      .andWhere('d.starts_at <= :now AND d.ends_at > :now', { now })
      .getMany();

    return {
      userId,
      name: user.name ?? `#${userId}`,
      systemRoles,
      scopes,
      isAdmin: scopes.some(
        (s) =>
          s.role === FinanceRole.ADMIN &&
          s.companyId === null &&
          s.departmentId === null,
      ),
      delegations: delegations.map((d) => ({
        delegatorId: d.delegatorId,
        companyId: d.companyId,
        requestType: d.requestType,
      })),
    };
  }

  hasRole(
    ctx: FinanceContext,
    role: FinanceRole,
    companyId?: number | null,
    departmentId?: number | null,
  ): boolean {
    return ctx.scopes.some(
      (scope) =>
        scope.role === role &&
        (companyId === undefined ||
          covers(scope, companyId, departmentId ?? null)),
    );
  }

  hasAnyRole(ctx: FinanceContext, roles: FinanceRole[]): boolean {
    return ctx.scopes.some((scope) => roles.includes(scope.role));
  }

  assertAdmin(ctx: FinanceContext) {
    if (!ctx.isAdmin) {
      throw new ForbiddenException(
        'Chỉ quản trị phân hệ tài chính được thực hiện thao tác này',
      );
    }
  }

  /** Được dùng màn Cấu hình quy trình: quản trị phân hệ hoặc Nhân sự. */
  canConfigure(ctx: FinanceContext): boolean {
    return (
      ctx.isAdmin ||
      ctx.systemRoles.some((role) =>
        FINANCE_CONFIG_SYSTEM_ROLES.includes(role),
      )
    );
  }

  assertCanConfigure(ctx: FinanceContext) {
    if (!this.canConfigure(ctx)) {
      throw new ForbiddenException(
        'Chỉ quản trị phân hệ tài chính hoặc nhân sự được thực hiện thao tác này',
      );
    }
  }

  /** Thấy toàn bộ phiếu của công ty/phòng ban nhờ vai trò được gán. */
  private coversByRole(ctx: FinanceContext, request: ScopedRequest) {
    return ctx.scopes.some(
      (scope) =>
        VIEW_ROLES.includes(scope.role) &&
        covers(scope, request.companyId, request.departmentId),
    );
  }

  canView(
    ctx: FinanceContext,
    request: ScopedRequest,
    steps: FinancialApprovalStep[] = [],
  ): boolean {
    if (ctx.isAdmin) return true;
    if (
      request.requesterId === ctx.userId ||
      request.createdById === ctx.userId ||
      request.directManagerId === ctx.userId
    ) {
      return true;
    }
    if (this.coversByRole(ctx, request)) return true;
    const delegatorIds = this.delegatorIdsFor(ctx, request);
    return steps.some(
      (step) =>
        step.actedById === ctx.userId ||
        step.candidateApproverIds?.includes(ctx.userId) ||
        (step.status === StepStatus.PENDING &&
          step.candidateApproverIds?.some((id) => delegatorIds.includes(id))),
    );
  }

  assertView(
    ctx: FinanceContext,
    request: ScopedRequest,
    steps: FinancialApprovalStep[] = [],
  ) {
    if (!this.canView(ctx, request, steps)) {
      throw new ForbiddenException('Bạn không có quyền xem chứng từ này');
    }
  }

  /** Người ghi nhận chi/thu tiền: kế toán, thủ quỹ hoặc quản trị — không phải chính người nhận. */
  canRecordMoney(ctx: FinanceContext, request: ScopedRequest): boolean {
    if (request.requesterId === ctx.userId) return false;
    return (
      ctx.isAdmin ||
      this.hasRole(
        ctx,
        FinanceRole.ACCOUNTANT,
        request.companyId,
        request.departmentId,
      ) ||
      this.hasRole(
        ctx,
        FinanceRole.CASHIER,
        request.companyId,
        request.departmentId,
      )
    );
  }

  /** Huỷ phiếu chi/thu: kế toán hoặc quản trị. */
  canVoidMoney(ctx: FinanceContext, request: ScopedRequest): boolean {
    if (request.requesterId === ctx.userId) return false;
    return (
      ctx.isAdmin ||
      this.hasRole(
        ctx,
        FinanceRole.ACCOUNTANT,
        request.companyId,
        request.departmentId,
      )
    );
  }

  canConfirmDeduction(ctx: FinanceContext, request: ScopedRequest): boolean {
    if (request.requesterId === ctx.userId) return false;
    return (
      ctx.isAdmin ||
      this.hasRole(
        ctx,
        FinanceRole.ACCOUNTANT,
        request.companyId,
        request.departmentId,
      ) ||
      ctx.systemRoles.some((role) =>
        PAYROLL_DEDUCTION_SYSTEM_ROLES.includes(role),
      )
    );
  }

  /** Thông tin tài khoản ngân hàng đầy đủ. */
  canSeeBank(ctx: FinanceContext, request: ScopedRequest): boolean {
    return (
      request.requesterId === ctx.userId ||
      ctx.isAdmin ||
      this.hasRole(
        ctx,
        FinanceRole.ACCOUNTANT,
        request.companyId,
        request.departmentId,
      ) ||
      this.hasRole(
        ctx,
        FinanceRole.CASHIER,
        request.companyId,
        request.departmentId,
      )
    );
  }

  /** Số lương dự kiến / dữ liệu lương. */
  canSeeSalary(ctx: FinanceContext, request: ScopedRequest): boolean {
    return (
      request.requesterId === ctx.userId ||
      ctx.isAdmin ||
      this.hasRole(
        ctx,
        FinanceRole.ACCOUNTANT,
        request.companyId,
        request.departmentId,
      ) ||
      ctx.systemRoles.some((role) =>
        PAYROLL_DEDUCTION_SYSTEM_ROLES.includes(role),
      )
    );
  }

  /** Những người mà `ctx` đang được uỷ quyền duyệt thay, trong phạm vi phiếu này. */
  delegatorIdsFor(
    ctx: FinanceContext,
    request: Partial<Pick<FinancialRequest, 'companyId' | 'type'>>,
  ): number[] {
    return ctx.delegations
      .filter(
        (d) =>
          (d.companyId === null || d.companyId === request.companyId) &&
          (d.requestType === null || d.requestType === request.type),
      )
      .map((d) => d.delegatorId);
  }

  /**
   * Người đang đăng nhập có được xử lý bước này không, và nếu có thì với tư
   * cách chính mình hay uỷ quyền của ai. Danh sách ứng viên đã loại người đề
   * nghị theo chính sách tự duyệt; người được uỷ quyền cũng không được duyệt
   * phiếu của chính mình.
   */
  eligibility(
    ctx: FinanceContext,
    request: Pick<FinancialRequest, 'requesterId' | 'companyId' | 'type'>,
    step: Pick<FinancialApprovalStep, 'candidateApproverIds' | 'status'>,
  ): { eligible: boolean; onBehalfOfId: number | null } {
    if (step.status !== StepStatus.PENDING) {
      return { eligible: false, onBehalfOfId: null };
    }
    const candidates = step.candidateApproverIds ?? [];
    if (candidates.includes(ctx.userId)) {
      return { eligible: true, onBehalfOfId: null };
    }
    if (request.requesterId === ctx.userId) {
      return { eligible: false, onBehalfOfId: null };
    }
    const delegator = this.delegatorIdsFor(ctx, request).find((id) =>
      candidates.includes(id),
    );
    return delegator
      ? { eligible: true, onBehalfOfId: delegator }
      : { eligible: false, onBehalfOfId: null };
  }

  /**
   * Danh sách người được duyệt một bước, theo phân quyền hiện hành.
   * `excluded` = người đề nghị đã bị loại (chế độ BLOCK/SKIP_STEP).
   */
  async resolveCandidates(
    step: Pick<
      FinancialApprovalStep,
      'approverType' | 'approverRole' | 'approverEmployeeId'
    >,
    request: Pick<
      FinancialRequest,
      | 'companyId'
      | 'departmentId'
      | 'directManagerId'
      | 'requesterId'
      | 'totalAmount'
    >,
    selfMode: SelfApprovalMode,
  ): Promise<{ candidates: number[]; requesterWasCandidate: boolean }> {
    let ids: number[] = [];
    if (step.approverType === ApproverType.DIRECT_MANAGER) {
      ids = request.directManagerId ? [request.directManagerId] : [];
    } else if (step.approverType === ApproverType.EMPLOYEE) {
      ids = step.approverEmployeeId ? [step.approverEmployeeId] : [];
    } else if (step.approverRole) {
      ids = await this.employeesWithRole(
        step.approverRole,
        request.companyId,
        request.departmentId,
        request.totalAmount,
      );
    }

    if (ids.length) {
      const active = await this.employeeRepo
        .createQueryBuilder('e')
        .select('e.id', 'id')
        .where('e.id IN (:...ids)', { ids })
        .andWhere('COALESCE(e.isActive, true) = true')
        .getRawMany<{ id: number }>();
      const activeIds = new Set(active.map((row) => Number(row.id)));
      ids = ids.filter((id) => activeIds.has(id));
    }

    const requesterWasCandidate = ids.includes(request.requesterId);
    const candidates =
      selfMode === SelfApprovalMode.ALLOW
        ? ids
        : ids.filter((id) => id !== request.requesterId);
    return {
      candidates: [...new Set(candidates)].sort((a, b) => a - b),
      requesterWasCandidate,
    };
  }

  /** Nhân viên giữ vai trò trong phạm vi (gán tường minh + suy từ role hệ thống), lọc theo hạn mức duyệt. */
  async employeesWithRole(
    role: FinanceRole,
    companyId: number,
    departmentId: number | null,
    amount?: number,
  ): Promise<number[]> {
    const assignments = await this.assignmentRepo
      .createQueryBuilder('a')
      .where('a.role = :role AND a.is_active = true', { role })
      .andWhere('(a.company_id IS NULL OR a.company_id = :companyId)', {
        companyId,
      })
      .andWhere(
        departmentId
          ? '(a.department_id IS NULL OR a.department_id = :departmentId)'
          : 'a.department_id IS NULL',
        { departmentId },
      )
      .getMany();
    const explicit = assignments
      .filter(
        (a) =>
          amount === undefined ||
          a.approvalLimit === null ||
          a.approvalLimit >= amount,
      )
      .map((a) => a.employeeId);

    const systemRoles = Object.entries(IMPLICIT_FINANCE_ROLES)
      .filter(([, roles]) => roles.includes(role))
      .map(([systemRole]) => systemRole);
    let implicit: number[] = [];
    if (systemRoles.length) {
      const rows = await this.employeeRepo
        .createQueryBuilder('e')
        .select('e.id', 'id')
        .where('e.roles && :roles', { roles: systemRoles })
        .andWhere('COALESCE(e.isActive, true) = true')
        .getRawMany<{ id: number }>();
      implicit = rows.map((row) => Number(row.id));
    }
    return [...new Set([...explicit, ...implicit])];
  }

  /**
   * Quản lý trực tiếp hợp lệ cho người đề nghị: giám đốc, trưởng/phó phòng và
   * người được gán vai trò MANAGER phủ công ty + phòng ban. Giám đốc đứng đầu,
   * rồi tới trưởng/phó phòng, mỗi nhóm xếp theo tên.
   */
  async eligibleManagers(companyId: number, departmentId: number | null) {
    const ids = await this.employeesWithRole(
      FinanceRole.MANAGER,
      companyId,
      departmentId,
    );
    const employees = await this.employeeRepo
      .createQueryBuilder('e')
      .select(['e.id', 'e.name', 'e.roles'])
      .where('COALESCE(e.isActive, true) = true')
      .andWhere(
        new Brackets((w) => {
          w.where('e.roles && :managerRoles', {
            managerRoles: DIRECT_MANAGER_SYSTEM_ROLES,
          });
          if (ids.length) w.orWhere('e.id IN (:...ids)', { ids });
        }),
      )
      .orderBy('e.name', 'ASC')
      .getMany();
    const rank = (e: Employee) => {
      const roles = e.roles ?? [];
      if (roles.some((r) => r === 'director' || r === 'director_la')) return 0;
      return roles.some((r) => DIRECT_MANAGER_SYSTEM_ROLES.includes(r)) ? 1 : 2;
    };
    return employees.sort((a, b) => rank(a) - rank(b));
  }

  /**
   * Quản lý trực tiếp của riêng một phòng ban, theo thứ tự ưu tiên: người được
   * gán vai trò MANAGER đúng phòng ban đó (gán riêng công ty đứng trước gán
   * mọi công ty), rồi trưởng/phó phòng thuộc phòng ban. Gán MANAGER "mọi phòng
   * ban" không tính — đó không phải quản lý của phòng nào. `companyId` NULL =
   * không lọc theo công ty.
   */
  async departmentManagerIds(
    companyId: number | null,
    departmentId: number | null,
  ): Promise<number[]> {
    if (!departmentId) return [];
    const assignments = (
      await this.assignmentRepo.find({
        where: { role: FinanceRole.MANAGER, isActive: true, departmentId },
        order: { id: 'ASC' },
      })
    )
      .filter(
        (a) =>
          companyId === null ||
          a.companyId === null ||
          a.companyId === companyId,
      )
      .sort(
        (a, b) => Number(a.companyId === null) - Number(b.companyId === null),
      );
    const heads = await this.employeeRepo
      .createQueryBuilder('e')
      .select('e.id', 'id')
      .where('e.department_id = :departmentId', { departmentId })
      .andWhere('e.roles && :headRoles', { headRoles: DEPARTMENT_HEAD_ROLES })
      .orderBy('e.name', 'ASC')
      .getRawMany<{ id: number }>();

    const ids = [
      ...new Set([
        ...assignments.map((a) => a.employeeId),
        ...heads.map((row) => Number(row.id)),
      ]),
    ];
    if (!ids.length) return [];
    const active = await this.employeeRepo
      .createQueryBuilder('e')
      .select('e.id', 'id')
      .where('e.id IN (:...ids)', { ids })
      .andWhere('COALESCE(e.isActive, true) = true')
      .getRawMany<{ id: number }>();
    const activeIds = new Set(active.map((row) => Number(row.id)));
    return ids.filter((id) => activeIds.has(id));
  }

  /**
   * Gắn điều kiện "được xem" vào truy vấn danh sách/báo cáo (alias `r`).
   * Giống hệt `canView` để danh sách và chi tiết không lệch nhau.
   */
  applyVisibility<T extends object>(
    qb: SelectQueryBuilder<T>,
    ctx: FinanceContext,
    alias = 'r',
  ) {
    qb.andWhere(`${alias}.deleted_at IS NULL`);
    if (ctx.isAdmin) return qb;

    const delegatorIds = [
      ...new Set(ctx.delegations.map((d) => d.delegatorId)),
    ];
    qb.andWhere(
      new Brackets((w) => {
        w.where(`${alias}.requester_id = :visUid`, { visUid: ctx.userId })
          .orWhere(`${alias}.created_by_id = :visUid`)
          .orWhere(`${alias}.direct_manager_id = :visUid`)
          .orWhere(
            `EXISTS (SELECT 1 FROM financial_approval_steps vs WHERE vs.request_id = ${alias}.id AND (:visUid = ANY(vs.candidate_approver_ids) OR vs.acted_by_id = :visUid${
              delegatorIds.length
                ? ` OR (vs.status = 'PENDING' AND vs.candidate_approver_ids && ARRAY[:...visDelegators]::int[])`
                : ''
            }))`,
            { visDelegators: delegatorIds },
          );
        ctx.scopes
          .filter((scope) => VIEW_ROLES.includes(scope.role))
          .forEach((scope, index) => {
            const parts: string[] = [];
            const params: Record<string, number> = {};
            if (scope.companyId !== null) {
              parts.push(`${alias}.company_id = :visC${index}`);
              params[`visC${index}`] = scope.companyId;
            }
            if (scope.departmentId !== null) {
              parts.push(`${alias}.department_id = :visD${index}`);
              params[`visD${index}`] = scope.departmentId;
            }
            w.orWhere(
              parts.length ? `(${parts.join(' AND ')})` : 'TRUE',
              params,
            );
          });
      }),
    );
    return qb;
  }

  /** Điều kiện "chờ tôi duyệt" (alias bước `s`, phiếu `r`). */
  applyPendingForMe<T extends object>(
    qb: SelectQueryBuilder<T>,
    ctx: FinanceContext,
  ) {
    const delegatorIds = [
      ...new Set(ctx.delegations.map((d) => d.delegatorId)),
    ];
    qb.andWhere('r.approval_status = :pendingStatus', {
      pendingStatus: ApprovalStatus.PENDING,
    }).andWhere(
      `EXISTS (SELECT 1 FROM financial_approval_steps ps WHERE ps.request_id = r.id AND ps.round = r.current_round AND ps.status = 'PENDING' AND (:pfmUid = ANY(ps.candidate_approver_ids)${
        delegatorIds.length
          ? ` OR (r.requester_id <> :pfmUid AND ps.candidate_approver_ids && ARRAY[:...pfmDelegators]::int[])`
          : ''
      }))`,
      { pfmUid: ctx.userId, pfmDelegators: delegatorIds },
    );
    return qb;
  }

  /** Che số tài khoản: giữ 4 số cuối. */
  static maskAccount(value: string | null): string | null {
    if (!value) return value;
    const tail = value.replace(/\s+/g, '').slice(-4);
    return `•••• ${tail}`;
  }

  async findGlobalAdmins(): Promise<number[]> {
    const explicit = await this.assignmentRepo.find({
      where: {
        role: FinanceRole.ADMIN,
        isActive: true,
        companyId: IsNull(),
        departmentId: IsNull(),
      },
    });
    const implicit = await this.employeesWithRole(FinanceRole.ADMIN, 0, null);
    return [...new Set([...explicit.map((a) => a.employeeId), ...implicit])];
  }
}
