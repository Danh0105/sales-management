import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
import { HrAccountRoleAssignment } from '../access/entities/hr-account-role-assignment.entity';
import { HrRoleDefinitionPermission } from '../access/entities/hr-role-definition-permission.entity';
import { HrRole } from '../access/entities/hr-role.entity';
import { HrScope } from '../access/hr-permission';

export interface NewAssignment {
  accountId: number;
  roleCode: string;
  scope: HrScope;
  scopeRefId: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string;
  grantedBy: number | null;
}

@Injectable()
export class HrRoleAdminRepository {
  constructor(
    @InjectRepository(HrRole) private readonly roles: Repository<HrRole>,
    @InjectRepository(HrRoleDefinitionPermission)
    private readonly rolePermissions: Repository<HrRoleDefinitionPermission>,
    @InjectRepository(HrAccountRoleAssignment)
    private readonly assignments: Repository<HrAccountRoleAssignment>,
  ) {}

  listRoles(): Promise<HrRole[]> {
    return this.roles.find({ order: { code: 'ASC' } });
  }

  findRole(code: string): Promise<HrRole | null> {
    return this.roles.findOne({ where: { code } });
  }

  listRolePermissionCodes(code: string): Promise<string[]> {
    return this.rolePermissions
      .find({ where: { roleCode: code }, order: { permissionCode: 'ASC' } })
      .then((rows) => rows.map((r) => r.permissionCode));
  }

  listAssignments(accountId: number): Promise<HrAccountRoleAssignment[]> {
    return this.assignments.find({
      where: { accountId },
      order: { grantedAt: 'DESC', id: 'DESC' },
    });
  }

  findAssignment(
    id: number,
    manager?: EntityManager,
  ): Promise<HrAccountRoleAssignment | null> {
    const repo =
      manager?.getRepository(HrAccountRoleAssignment) ?? this.assignments;
    return repo.findOne({ where: { id } });
  }

  /** Đọc và KHOÁ dòng assignment tới hết transaction (SELECT ... FOR UPDATE). */
  findAssignmentForUpdate(
    manager: EntityManager,
    id: number,
  ): Promise<HrAccountRoleAssignment | null> {
    return manager
      .getRepository(HrAccountRoleAssignment)
      .createQueryBuilder('a')
      .setLock('pessimistic_write')
      .where('a.id = :id', { id })
      .getOne();
  }

  /** Assignment CHƯA thu hồi cùng tài khoản + role + scope + đơn vị. */
  findUnrevokedDuplicate(
    manager: EntityManager,
    key: Pick<NewAssignment, 'accountId' | 'roleCode' | 'scope' | 'scopeRefId'>,
  ): Promise<HrAccountRoleAssignment | null> {
    return manager.getRepository(HrAccountRoleAssignment).findOne({
      where: {
        accountId: key.accountId,
        roleCode: key.roleCode,
        scope: key.scope,
        scopeRefId: key.scopeRefId === null ? IsNull() : key.scopeRefId,
        revokedAt: IsNull(),
      },
    });
  }

  async insertAssignment(
    manager: EntityManager,
    row: NewAssignment,
  ): Promise<HrAccountRoleAssignment> {
    const repo = manager.getRepository(HrAccountRoleAssignment);
    const result = await repo.insert(row);
    const id = (result.identifiers[0] as { id: number }).id;
    return (await repo.findOne({ where: { id } }))!;
  }

  /**
   * Thu hồi có điều kiện version — trả về số dòng bị ảnh hưởng. 0 = người khác
   * vừa sửa/thu hồi trước (→ 409), không bao giờ ghi đè im lặng.
   */
  async revokeAssignment(
    manager: EntityManager,
    id: number,
    expectedVersion: number,
    revokedBy: number,
    reason: string,
  ): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(HrAccountRoleAssignment)
      .set({
        revokedAt: () => 'now()',
        revokedBy,
        revokeReason: reason,
        version: () => '"version" + 1',
      })
      .where('id = :id', { id })
      .andWhere('version = :version', { version: expectedVersion })
      .andWhere('revoked_at IS NULL')
      .execute();
    return result.affected ?? 0;
  }
}
