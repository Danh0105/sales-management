import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';

import { Department } from '../department/department.entity';
import { Employee } from '../employee/employee.entity';
import { isEmployeeAdmin } from '../employee/employee-roles';
import { AuthUser } from '../type/auth-user.type';
import {
  AssignmentDto,
  CategoryDto,
  CompanyDto,
  CreateAccountDto,
  DelegationDto,
  EmployeeDepartmentDto,
  PolicyDto,
  UpdateCategoryDto,
  UpdateCompanyDto,
  WorkflowDto,
} from './dto/financial-config.dto';
import { FinancialApprovalDelegation } from './entities/financial-approval-delegation.entity';
import { FinancialApprovalStep } from './entities/financial-approval-step.entity';
import { FinancialApprovalWorkflow } from './entities/financial-approval-workflow.entity';
import { FinancialCompany } from './entities/financial-company.entity';
import { FinancialExpenseCategory } from './entities/financial-expense-category.entity';
import { FinancialPolicy } from './entities/financial-policy.entity';
import { FinancialRequest } from './entities/financial-request.entity';
import { FinancialRoleAssignment } from './entities/financial-role-assignment.entity';
import { FinancialWorkflowStep } from './entities/financial-workflow-step.entity';
import { FinancialAccessService } from './financial-access.service';
import { writeAudit } from './financial-notify.service';
import {
  ApprovalStatus,
  ApproverType,
  FinanceRole,
  IMPLICIT_FINANCE_ROLES,
  REQUEST_TYPE_VALUES,
  SelfApprovalMode,
  StepStatus,
} from './financial-request.constants';
import { readStoredFile, storeFile } from './financial-storage';

@Injectable()
export class FinancialConfigService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly access: FinancialAccessService,
    @InjectRepository(FinancialCompany)
    private readonly companyRepo: Repository<FinancialCompany>,
    @InjectRepository(FinancialExpenseCategory)
    private readonly categoryRepo: Repository<FinancialExpenseCategory>,
    @InjectRepository(FinancialApprovalWorkflow)
    private readonly workflowRepo: Repository<FinancialApprovalWorkflow>,
    @InjectRepository(FinancialRoleAssignment)
    private readonly assignmentRepo: Repository<FinancialRoleAssignment>,
    @InjectRepository(FinancialPolicy)
    private readonly policyRepo: Repository<FinancialPolicy>,
    @InjectRepository(FinancialApprovalDelegation)
    private readonly delegationRepo: Repository<FinancialApprovalDelegation>,
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
  ) {}

  private async configurator(user: AuthUser) {
    const ctx = await this.access.context(user);
    this.access.assertCanConfigure(ctx);
    return ctx;
  }

  /**
   * Nhân sự cấu hình được phân quyền nhưng không được dùng chính màn này để tự
   * nâng quyền: vai trò quản trị phân hệ và vai trò của chính mình phải do quản
   * trị thao tác.
   */
  private assertAssignmentAllowed(
    ctx: { userId: number; isAdmin: boolean },
    target: { employeeId: number; role: FinanceRole },
  ) {
    if (ctx.isAdmin) return;
    if (target.role === FinanceRole.ADMIN) {
      throw new ForbiddenException(
        'Chỉ quản trị phân hệ được gán hoặc thu hồi vai trò quản trị',
      );
    }
    if (target.employeeId === ctx.userId) {
      throw new ForbiddenException(
        'Không được tự gán hoặc thu hồi vai trò tài chính của chính mình',
      );
    }
  }

  private audit(
    manager: EntityManager,
    ctx: { userId: number; name: string },
    entityType: string,
    entityId: number | null,
    action: string,
    changes?: Record<string, unknown>,
  ) {
    return writeAudit(manager, {
      entityType,
      entityId,
      action,
      actorId: ctx.userId,
      actorName: ctx.name,
      changes: changes ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // Tổng hợp cho màn cấu hình
  // ---------------------------------------------------------------------------

  async overview(user: AuthUser) {
    const ctx = await this.configurator(user);
    const [
      companies,
      categories,
      workflows,
      assignments,
      policies,
      delegations,
      employees,
      departments,
    ] = await Promise.all([
      this.companyRepo.find({ order: { name: 'ASC' } }),
      this.categoryRepo.find({ order: { sortOrder: 'ASC', name: 'ASC' } }),
      this.workflowRepo.find({
        relations: ['steps'],
        order: { isActive: 'DESC', id: 'ASC' },
      }),
      this.assignmentRepo.find({
        relations: ['employee', 'company', 'department'],
        order: { role: 'ASC', id: 'ASC' },
      }),
      this.policyRepo.find({ order: { scopeKey: 'ASC' } }),
      this.delegationRepo.find({
        relations: ['delegator', 'delegate'],
        order: { createdAt: 'DESC' },
        take: 200,
      }),
      this.employeeRepo
        .createQueryBuilder('e')
        .leftJoinAndSelect('e.department', 'd')
        .select(['e.id', 'e.name', 'e.roles', 'e.isActive', 'd.id', 'd.name'])
        .where('COALESCE(e.isActive, true) = true')
        .orderBy('e.name', 'ASC')
        .getMany(),
      this.dataSource
        .getRepository(Department)
        .find({ order: { name: 'ASC' } }),
    ]);
    const departmentManagerIds = await Promise.all(
      departments.map((d) => this.access.departmentManagerIds(null, d.id)),
    );
    const employeeName = new Map(employees.map((e) => [e.id, e.name]));
    return {
      companies: companies.map((c) => ({
        ...c,
        logoPath: undefined,
        hasLogo: !!c.logoPath,
      })),
      categories,
      workflows: workflows.map((w) => ({
        ...w,
        steps: [...(w.steps ?? [])].sort((a, b) => a.stepOrder - b.stepOrder),
      })),
      assignments: assignments.map((a) => ({
        id: a.id,
        employeeId: a.employeeId,
        employeeName: a.employee?.name ?? `#${a.employeeId}`,
        role: a.role,
        companyId: a.companyId,
        companyName: a.company?.name ?? null,
        departmentId: a.departmentId,
        departmentName: a.department?.name ?? null,
        approvalLimit: a.approvalLimit,
        isActive: a.isActive,
        note: a.note,
      })),
      implicitRoles: IMPLICIT_FINANCE_ROLES,
      policies,
      delegations: delegations.map((d) => ({
        id: d.id,
        delegatorId: d.delegatorId,
        delegatorName: d.delegator?.name ?? `#${d.delegatorId}`,
        delegateId: d.delegateId,
        delegateName: d.delegate?.name ?? `#${d.delegateId}`,
        companyId: d.companyId,
        requestType: d.requestType,
        startsAt: d.startsAt,
        endsAt: d.endsAt,
        reason: d.reason,
        revokedAt: d.revokedAt,
      })),
      employees: employees.map((e) => ({
        id: e.id,
        name: e.name,
        departmentId: e.department?.id ?? null,
        departmentName: e.department?.name ?? null,
      })),
      departments: departments.map((d, index) => ({
        id: d.id,
        name: d.name,
        managers: departmentManagerIds[index].map((id) => ({
          id,
          name: employeeName.get(id) ?? `#${id}`,
        })),
      })),
      me: { id: ctx.userId },
      canCreateAccount: isEmployeeAdmin(user),
    };
  }

  // ---------------------------------------------------------------------------
  // Công ty
  // ---------------------------------------------------------------------------

  async createCompany(user: AuthUser, dto: CompanyDto) {
    const ctx = await this.configurator(user);
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(FinancialCompany);
      if (await repo.findOne({ where: { code: dto.code } })) {
        throw new ConflictException('Mã công ty đã tồn tại');
      }
      const company = await repo.save(
        repo.create({
          ...dto,
          formCodes: this.cleanFormCodes(dto.formCodes),
          isActive: dto.isActive ?? true,
        }),
      );
      await this.audit(manager, ctx, 'COMPANY', company.id, 'COMPANY_CREATED', {
        code: company.code,
        name: company.name,
      });
      return company;
    });
  }

  async updateCompany(user: AuthUser, id: number, dto: UpdateCompanyDto) {
    const ctx = await this.configurator(user);
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(FinancialCompany);
      const company = await repo.findOne({ where: { id } });
      if (!company) throw new NotFoundException('Không tìm thấy công ty');
      Object.assign(company, {
        ...dto,
        ...(dto.formCodes
          ? { formCodes: this.cleanFormCodes(dto.formCodes) }
          : {}),
      });
      await repo.save(company);
      await this.audit(manager, ctx, 'COMPANY', id, 'COMPANY_UPDATED', {
        fields: Object.keys(dto),
      });
      return company;
    });
  }

  private cleanFormCodes(input?: Record<string, string>) {
    const result: Record<string, string> = {};
    for (const type of REQUEST_TYPE_VALUES) {
      const value = input?.[type];
      if (typeof value === 'string' && value.trim())
        result[type] = value.trim().slice(0, 50);
    }
    return result;
  }

  async uploadLogo(user: AuthUser, id: number, file: Express.Multer.File) {
    const ctx = await this.configurator(user);
    if (!file) throw new BadRequestException('Chưa chọn tệp logo');
    if (!/\.(png|jpe?g)$/i.test(file.originalname)) {
      throw new BadRequestException('Logo chỉ nhận PNG hoặc JPG');
    }
    const stored = await storeFile(file, 'logos');
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(FinancialCompany);
      const company = await repo.findOne({ where: { id } });
      if (!company) throw new NotFoundException('Không tìm thấy công ty');
      company.logoPath = stored.storagePath;
      await repo.save(company);
      await this.audit(manager, ctx, 'COMPANY', id, 'COMPANY_LOGO_UPDATED', {
        file: stored.originalName,
      });
      return { success: true };
    });
  }

  /** Logo dùng chung cho mọi người đăng nhập (in chứng từ). */
  async companyLogo(id: number) {
    const company = await this.companyRepo.findOne({ where: { id } });
    if (!company?.logoPath) throw new NotFoundException('Công ty chưa có logo');
    const buffer = await readStoredFile(company.logoPath);
    const mime = /\.png$/i.test(company.logoPath) ? 'image/png' : 'image/jpeg';
    return { buffer, mime };
  }

  // ---------------------------------------------------------------------------
  // Danh mục chi phí
  // ---------------------------------------------------------------------------

  async createCategory(user: AuthUser, dto: CategoryDto) {
    const ctx = await this.configurator(user);
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(FinancialExpenseCategory);
      if (await repo.findOne({ where: { code: dto.code } })) {
        throw new ConflictException('Mã danh mục đã tồn tại');
      }
      const category = await repo.save(
        repo.create({
          ...dto,
          limitAmount: dto.limitAmount ?? null,
          description: dto.description ?? null,
          sortOrder: dto.sortOrder ?? 0,
          isActive: dto.isActive ?? true,
        }),
      );
      await this.audit(
        manager,
        ctx,
        'CATEGORY',
        category.id,
        'CATEGORY_CREATED',
        {
          code: category.code,
          limitAmount: category.limitAmount,
        },
      );
      return category;
    });
  }

  async updateCategory(user: AuthUser, id: number, dto: UpdateCategoryDto) {
    const ctx = await this.configurator(user);
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(FinancialExpenseCategory);
      const category = await repo.findOne({ where: { id } });
      if (!category) throw new NotFoundException('Không tìm thấy danh mục');
      const before = {
        limitAmount: category.limitAmount,
        isActive: category.isActive,
      };
      Object.assign(category, dto);
      await repo.save(category);
      await this.audit(manager, ctx, 'CATEGORY', id, 'CATEGORY_UPDATED', {
        before,
        after: {
          limitAmount: category.limitAmount,
          isActive: category.isActive,
        },
      });
      return category;
    });
  }

  // ---------------------------------------------------------------------------
  // Quy trình duyệt
  // ---------------------------------------------------------------------------

  private validateSteps(dto: WorkflowDto) {
    dto.steps.forEach((step, index) => {
      const label = `Cấp ${index + 1} (${step.name})`;
      if (step.approverType === ApproverType.ROLE && !step.approverRole) {
        throw new BadRequestException(`${label}: chọn vai trò duyệt`);
      }
      if (
        step.approverType === ApproverType.EMPLOYEE &&
        !step.approverEmployeeId
      ) {
        throw new BadRequestException(`${label}: chọn người duyệt`);
      }
    });
  }

  private async assertScopeFree(
    manager: EntityManager,
    dto: WorkflowDto,
    excludeId?: number,
  ) {
    if (dto.isActive === false) return;
    const qb = manager
      .getRepository(FinancialApprovalWorkflow)
      .createQueryBuilder('w')
      .where('w.is_active = true')
      .andWhere(
        dto.companyId ? 'w.company_id = :companyId' : 'w.company_id IS NULL',
        { companyId: dto.companyId },
      )
      .andWhere(
        dto.requestType
          ? 'w.request_type = :requestType'
          : 'w.request_type IS NULL',
        { requestType: dto.requestType },
      );
    if (excludeId) qb.andWhere('w.id <> :excludeId', { excludeId });
    const clash = await qb.getOne();
    if (clash) {
      throw new ConflictException(
        `Phạm vi này đã có quy trình đang hoạt động: "${clash.name}" — tắt quy trình đó trước`,
      );
    }
  }

  private async writeSteps(
    manager: EntityManager,
    workflowId: number,
    dto: WorkflowDto,
  ) {
    const repo = manager.getRepository(FinancialWorkflowStep);
    await repo.delete({ workflowId });
    await repo.save(
      dto.steps.map((step, index) =>
        repo.create({
          workflowId,
          stepOrder: index + 1,
          name: step.name.trim(),
          signatureSlot: step.signatureSlot ?? null,
          approverType: step.approverType,
          approverRole:
            step.approverType === ApproverType.ROLE
              ? (step.approverRole ?? null)
              : null,
          approverEmployeeId:
            step.approverType === ApproverType.EMPLOYEE
              ? (step.approverEmployeeId ?? null)
              : null,
          minAmount: step.minAmount ?? null,
          canAdjustAmounts: step.canAdjustAmounts ?? false,
          skippable: step.skippable ?? false,
        }),
      ),
    );
  }

  async createWorkflow(user: AuthUser, dto: WorkflowDto) {
    const ctx = await this.configurator(user);
    this.validateSteps(dto);
    return this.dataSource.transaction(async (manager) => {
      await this.assertScopeFree(manager, dto);
      const repo = manager.getRepository(FinancialApprovalWorkflow);
      const workflow = await repo.save(
        repo.create({
          name: dto.name.trim(),
          companyId: dto.companyId ?? null,
          requestType: dto.requestType ?? null,
          isActive: dto.isActive ?? true,
          isSequential: dto.isSequential ?? true,
          selfApprovalMode: dto.selfApprovalMode ?? SelfApprovalMode.BLOCK,
          allowWithdraw: dto.allowWithdraw ?? true,
          description: dto.description ?? null,
          createdById: ctx.userId,
          updatedById: ctx.userId,
        }),
      );
      await this.writeSteps(manager, workflow.id, dto);
      await this.audit(
        manager,
        ctx,
        'WORKFLOW',
        workflow.id,
        'WORKFLOW_CREATED',
        {
          name: workflow.name,
          steps: dto.steps.map((s) => s.name),
        },
      );
      return workflow;
    });
  }

  /**
   * Sửa quy trình chỉ ảnh hưởng phiếu GỬI SAU — phiếu đang duyệt đã chụp các
   * bước của riêng nó lúc gửi.
   */
  async updateWorkflow(user: AuthUser, id: number, dto: WorkflowDto) {
    const ctx = await this.configurator(user);
    this.validateSteps(dto);
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(FinancialApprovalWorkflow);
      const workflow = await repo.findOne({ where: { id } });
      if (!workflow) throw new NotFoundException('Không tìm thấy quy trình');
      await this.assertScopeFree(manager, dto, id);
      Object.assign(workflow, {
        name: dto.name.trim(),
        companyId: dto.companyId ?? null,
        requestType: dto.requestType ?? null,
        isActive: dto.isActive ?? workflow.isActive,
        isSequential: dto.isSequential ?? workflow.isSequential,
        selfApprovalMode: dto.selfApprovalMode ?? workflow.selfApprovalMode,
        allowWithdraw: dto.allowWithdraw ?? workflow.allowWithdraw,
        description: dto.description ?? null,
        updatedById: ctx.userId,
      });
      await repo.save(workflow);
      await this.writeSteps(manager, id, dto);
      await this.audit(manager, ctx, 'WORKFLOW', id, 'WORKFLOW_UPDATED', {
        name: workflow.name,
        isActive: workflow.isActive,
        steps: dto.steps.map((s) => s.name),
      });
      return workflow;
    });
  }

  // ---------------------------------------------------------------------------
  // Phân quyền
  // ---------------------------------------------------------------------------

  async createAssignment(user: AuthUser, dto: AssignmentDto) {
    const ctx = await this.configurator(user);
    this.assertAssignmentAllowed(ctx, dto);
    const saved = await this.dataSource.transaction(async (manager) => {
      const employee = await manager
        .getRepository(Employee)
        .findOne({ where: { id: dto.employeeId } });
      if (!employee) throw new BadRequestException('Không tìm thấy nhân viên');
      const repo = manager.getRepository(FinancialRoleAssignment);
      const qb = repo
        .createQueryBuilder('a')
        .where(
          'a.employee_id = :employeeId AND a.role = :role AND a.is_active = true',
          {
            employeeId: dto.employeeId,
            role: dto.role,
          },
        )
        .andWhere(
          dto.companyId ? 'a.company_id = :companyId' : 'a.company_id IS NULL',
          {
            companyId: dto.companyId,
          },
        )
        .andWhere(
          dto.departmentId
            ? 'a.department_id = :departmentId'
            : 'a.department_id IS NULL',
          {
            departmentId: dto.departmentId,
          },
        );
      if (await qb.getOne())
        throw new ConflictException('Phân quyền này đã tồn tại');
      const assignment = await repo.save(
        repo.create({
          employeeId: dto.employeeId,
          role: dto.role,
          companyId: dto.companyId ?? null,
          departmentId: dto.departmentId ?? null,
          approvalLimit: dto.approvalLimit ?? null,
          note: dto.note ?? null,
          isActive: true,
          createdById: ctx.userId,
        }),
      );
      await this.audit(
        manager,
        ctx,
        'ASSIGNMENT',
        assignment.id,
        'ASSIGNMENT_CREATED',
        {
          employeeId: dto.employeeId,
          employeeName: employee.name,
          role: dto.role,
          companyId: assignment.companyId,
          departmentId: assignment.departmentId,
          approvalLimit: assignment.approvalLimit,
        },
      );
      return assignment;
    });
    await this.refreshPendingCandidates();
    return saved;
  }

  async removeAssignment(user: AuthUser, id: number) {
    const ctx = await this.configurator(user);
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(FinancialRoleAssignment);
      const assignment = await repo.findOne({ where: { id } });
      if (!assignment) throw new NotFoundException('Không tìm thấy phân quyền');
      this.assertAssignmentAllowed(ctx, assignment);
      assignment.isActive = false;
      await repo.save(assignment);
      await this.audit(manager, ctx, 'ASSIGNMENT', id, 'ASSIGNMENT_REVOKED', {
        employeeId: assignment.employeeId,
        role: assignment.role,
      });
    });
    await this.refreshPendingCandidates();
    return { success: true };
  }

  /**
   * Vai trò "Nhân viên": chuyển nhân viên vào phòng ban — đổi đúng cột phòng
   * ban của hồ sơ nhân viên. Phiếu đã lập giữ phòng ban lúc lập; phiếu mới tự
   * chọn quản lý trực tiếp của phòng ban mới.
   */
  async setEmployeeDepartment(
    user: AuthUser,
    employeeId: number,
    dto: EmployeeDepartmentDto,
  ) {
    const ctx = await this.configurator(user);
    return this.dataSource.transaction(async (manager) => {
      const employee = await manager.getRepository(Employee).findOne({
        where: { id: employeeId },
        relations: ['department'],
      });
      if (!employee) throw new NotFoundException('Không tìm thấy nhân viên');
      const department = await manager
        .getRepository(Department)
        .findOne({ where: { id: dto.departmentId } });
      if (!department)
        throw new BadRequestException('Không tìm thấy phòng ban');
      const fromDepartmentId = employee.department?.id ?? null;
      if (fromDepartmentId !== department.id) {
        await manager
          .getRepository(Employee)
          .update(employeeId, { department: { id: department.id } as never });
        await this.audit(
          manager,
          ctx,
          'EMPLOYEE',
          employeeId,
          'EMPLOYEE_DEPARTMENT_CHANGED',
          {
            employeeName: employee.name,
            fromDepartmentId,
            toDepartmentId: department.id,
          },
        );
      }
      return {
        employeeId,
        employeeName: employee.name ?? `#${employeeId}`,
        departmentId: department.id,
        departmentName: department.name,
      };
    });
  }

  /**
   * Tạo tài khoản đăng nhập (đăng nhập bằng số điện thoại) cho nhân viên mới,
   * role hệ thống cố định `employee`. Cấp quyền đăng nhập nên ngoài quản trị
   * phân hệ còn phải là người quản trị nhân sự — giống `POST /employees`.
   */
  async createAccount(user: AuthUser, dto: CreateAccountDto) {
    const ctx = await this.configurator(user);
    if (!isEmployeeAdmin(user)) {
      throw new ForbiddenException(
        'Chỉ giám đốc hoặc nhân sự được tạo tài khoản đăng nhập',
      );
    }
    const password = await bcrypt.hash(dto.password, 10);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(Employee);
        const department = await manager
          .getRepository(Department)
          .findOne({ where: { id: dto.departmentId } });
        if (!department)
          throw new BadRequestException('Không tìm thấy phòng ban');
        if (await repo.findOne({ where: { phone: dto.phone } })) {
          throw new ConflictException('Số điện thoại đã được sử dụng');
        }
        if (
          dto.email &&
          (await repo.findOne({ where: { email: dto.email } }))
        ) {
          throw new ConflictException('Email đã được sử dụng');
        }
        const employee = await repo.save(
          repo.create({
            name: dto.name,
            phone: dto.phone,
            email: dto.email ?? undefined,
            password,
            roles: ['employee'],
            department: { id: department.id } as Department,
          }),
        );
        await this.audit(
          manager,
          ctx,
          'EMPLOYEE',
          employee.id!,
          'ACCOUNT_CREATED',
          {
            employeeName: employee.name,
            roles: employee.roles,
            departmentId: department.id,
          },
        );
        return {
          id: employee.id!,
          name: employee.name!,
          departmentId: department.id,
          departmentName: department.name,
        };
      });
    } catch (error) {
      // Hai người tạo cùng lúc: kiểm tra trước vẫn lọt, ràng buộc UNIQUE chặn.
      if (
        error instanceof QueryFailedError &&
        (error as QueryFailedError & { code?: string }).code === '23505'
      ) {
        const detail = String(
          (error as QueryFailedError & { detail?: string }).detail ?? '',
        );
        throw new ConflictException(
          detail.includes('(email)')
            ? 'Email đã được sử dụng'
            : 'Số điện thoại đã được sử dụng',
        );
      }
      throw error;
    }
  }

  /**
   * Cập nhật danh sách người duyệt của các bước đang chờ theo phân quyền mới.
   * Bước không còn ai hợp lệ thì GIỮ danh sách cũ (không để phiếu treo vô chủ);
   * quản trị xử lý bằng cách gán người khác hoặc bỏ qua cấp nếu được phép.
   */
  async refreshPendingCandidates() {
    const steps = await this.dataSource
      .getRepository(FinancialApprovalStep)
      .createQueryBuilder('s')
      .innerJoinAndMapOne(
        's.request',
        FinancialRequest,
        'r',
        'r.id = s.request_id',
      )
      .where('s.status = :pending', { pending: StepStatus.PENDING })
      .andWhere('r.approval_status = :status', {
        status: ApprovalStatus.PENDING,
      })
      .andWhere('s.approver_type = :role', { role: ApproverType.ROLE })
      .getMany();
    const workflows = new Map(
      (await this.workflowRepo.find()).map((w) => [w.id, w]),
    );
    for (const step of steps) {
      const request = (step as unknown as { request: FinancialRequest })
        .request;
      const mode =
        (request.workflowId &&
          workflows.get(request.workflowId)?.selfApprovalMode) ||
        SelfApprovalMode.BLOCK;
      const { candidates } = await this.access.resolveCandidates(
        step,
        request,
        mode,
      );
      if (!candidates.length) continue;
      if (candidates.join(',') === (step.candidateApproverIds ?? []).join(','))
        continue;
      await this.dataSource
        .getRepository(FinancialApprovalStep)
        .update({ id: step.id }, { candidateApproverIds: candidates });
    }
  }

  // ---------------------------------------------------------------------------
  // Chính sách
  // ---------------------------------------------------------------------------

  async savePolicy(user: AuthUser, dto: PolicyDto) {
    const ctx = await this.configurator(user);
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(FinancialPolicy);
      const scopeKey = dto.companyId ? `COMPANY:${dto.companyId}` : 'GLOBAL';
      if (dto.companyId) {
        const company = await manager
          .getRepository(FinancialCompany)
          .findOne({ where: { id: dto.companyId } });
        if (!company) throw new BadRequestException('Không tìm thấy công ty');
      }
      const policy =
        (await repo.findOne({ where: { scopeKey } })) ??
        repo.create({ scopeKey });
      const before = { ...policy };
      const values: Omit<PolicyDto, 'companyId'> = { ...dto };
      delete (values as PolicyDto).companyId;
      Object.assign(policy, values, { updatedById: ctx.userId });
      await repo.save(policy);
      await this.audit(manager, ctx, 'POLICY', policy.id, 'POLICY_SAVED', {
        scopeKey,
        before: {
          salaryAdvanceMaxPerMonth: before.salaryAdvanceMaxPerMonth,
          salaryAdvanceMaxAmount: before.salaryAdvanceMaxAmount,
          salaryAdvanceMaxPercent: before.salaryAdvanceMaxPercent,
          maxDeductionPeriods: before.maxDeductionPeriods,
          advanceDueDays: before.advanceDueDays,
          expenseOverLimitMode: before.expenseOverLimitMode,
        },
        after: values,
      });
      return policy;
    });
  }

  // ---------------------------------------------------------------------------
  // Uỷ quyền
  // ---------------------------------------------------------------------------

  async myDelegations(user: AuthUser) {
    const ctx = await this.access.context(user);
    const rows = await this.delegationRepo.find({
      where: [{ delegatorId: ctx.userId }, { delegateId: ctx.userId }],
      relations: ['delegator', 'delegate'],
      order: { createdAt: 'DESC' },
      take: 100,
    });
    const employees = await this.employeeRepo
      .createQueryBuilder('e')
      .select(['e.id', 'e.name'])
      .where('COALESCE(e.isActive, true) = true')
      .andWhere('e.id <> :me', { me: ctx.userId })
      .orderBy('e.name', 'ASC')
      .getMany();
    return {
      delegations: rows.map((d) => ({
        id: d.id,
        delegatorId: d.delegatorId,
        delegatorName: d.delegator?.name ?? `#${d.delegatorId}`,
        delegateId: d.delegateId,
        delegateName: d.delegate?.name ?? `#${d.delegateId}`,
        companyId: d.companyId,
        requestType: d.requestType,
        startsAt: d.startsAt,
        endsAt: d.endsAt,
        reason: d.reason,
        revokedAt: d.revokedAt,
        canRevoke:
          !d.revokedAt &&
          (d.delegatorId === ctx.userId || this.access.canConfigure(ctx)),
      })),
      employees: employees.map((e) => ({ id: e.id, name: e.name })),
    };
  }

  async createDelegation(user: AuthUser, dto: DelegationDto) {
    const ctx = await this.access.context(user);
    const delegatorId = dto.delegatorId ?? ctx.userId;
    if (delegatorId !== ctx.userId) {
      if (!this.access.canConfigure(ctx)) {
        throw new ForbiddenException(
          'Chỉ quản trị hoặc nhân sự được uỷ quyền thay người khác',
        );
      }
      if (!ctx.isAdmin && dto.delegateId === ctx.userId) {
        throw new ForbiddenException(
          'Không được tự nhận uỷ quyền duyệt thay người khác',
        );
      }
    }
    if (delegatorId === dto.delegateId) {
      throw new BadRequestException('Không uỷ quyền cho chính mình');
    }
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (!(endsAt > startsAt))
      throw new BadRequestException('Thời hạn uỷ quyền không hợp lệ');
    if (endsAt.getTime() - startsAt.getTime() > 180 * 86_400_000) {
      throw new BadRequestException('Uỷ quyền tối đa 180 ngày');
    }
    return this.dataSource.transaction(async (manager) => {
      const delegate = await manager
        .getRepository(Employee)
        .findOne({ where: { id: dto.delegateId } });
      if (!delegate)
        throw new BadRequestException('Không tìm thấy người được uỷ quyền');
      const repo = manager.getRepository(FinancialApprovalDelegation);
      const delegation = await repo.save(
        repo.create({
          delegatorId,
          delegateId: dto.delegateId,
          companyId: dto.companyId ?? null,
          requestType: dto.requestType ?? null,
          startsAt,
          endsAt,
          reason: dto.reason ?? null,
          createdById: ctx.userId,
        }),
      );
      await this.audit(
        manager,
        ctx,
        'DELEGATION',
        delegation.id,
        'DELEGATION_CREATED',
        {
          delegatorId,
          delegateId: dto.delegateId,
          delegateName: delegate.name,
          companyId: delegation.companyId,
          requestType: delegation.requestType,
          startsAt: dto.startsAt,
          endsAt: dto.endsAt,
        },
      );
      return delegation;
    });
  }

  async revokeDelegation(user: AuthUser, id: number) {
    const ctx = await this.access.context(user);
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(FinancialApprovalDelegation);
      const delegation = await repo.findOne({ where: { id } });
      if (!delegation) throw new NotFoundException('Không tìm thấy uỷ quyền');
      if (
        delegation.delegatorId !== ctx.userId &&
        !this.access.canConfigure(ctx)
      ) {
        throw new ForbiddenException('Bạn không được thu hồi uỷ quyền này');
      }
      if (delegation.revokedAt) return delegation;
      delegation.revokedAt = new Date();
      delegation.revokedById = ctx.userId;
      await repo.save(delegation);
      await this.audit(manager, ctx, 'DELEGATION', id, 'DELEGATION_REVOKED');
      return delegation;
    });
  }
}
