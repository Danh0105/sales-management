import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { HrPermission } from '../access/hr-permission';
import {
  HR_PERMISSION_KEY,
  HrPermissionGuard,
} from '../access/hr-permission.guard';
import { AssignHrRoleDto } from './dto/assign-hr-role.dto';
import { RevokeHrRoleAssignmentDto } from './dto/revoke-hr-role-assignment.dto';
import { HrRoleAdminController } from './hr-role-admin.controller';

/**
 * Backend phải tự enforce quyền: mỗi endpoint phải gắn đúng permission và
 * controller phải chạy cả JwtAuthGuard lẫn HrPermissionGuard.
 */
describe('HrRoleAdminController — khai báo quyền', () => {
  const proto = HrRoleAdminController.prototype;
  const permissionOf = (method: keyof HrRoleAdminController) =>
    Reflect.getMetadata(HR_PERMISSION_KEY, proto[method]) as HrPermission;

  it('controller chạy JwtAuthGuard rồi HrPermissionGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, HrRoleAdminController)).toEqual(
      [JwtAuthGuard, HrPermissionGuard],
    );
  });

  it.each([
    ['assign', HrPermission.ACCESS_ADMIN],
    ['revoke', HrPermission.ACCESS_ADMIN],
    ['roles', HrPermission.ACCESS_VIEW],
    ['rolePermissions', HrPermission.ACCESS_VIEW],
    ['accountAssignments', HrPermission.ACCESS_VIEW],
    ['adminStatus', HrPermission.ACCESS_VIEW],
  ] as const)('%s yêu cầu %s', (method, permission) => {
    expect(permissionOf(method)).toBe(permission);
  });
});

describe('DTO', () => {
  const errorsOf = async (cls: new () => object, input: object) =>
    (await validate(plainToInstance(cls, input))).map((e) => e.property);

  it('AssignHrRoleDto hợp lệ (reason được trim)', async () => {
    const dto = plainToInstance(AssignHrRoleDto, {
      roleCode: 'HR_OFFICER',
      scope: 'BRANCH',
      scopeRefId: '3',
      reason: '   bổ nhiệm   ',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.reason).toBe('bổ nhiệm');
    expect(dto.scopeRefId).toBe(3);
  });

  it.each([
    [{ scope: 'GOD' }, 'scope'],
    [{ scope: 'company' }, 'scope'],
    [{ roleCode: 'nhansu' }, 'roleCode'],
    [{ reason: '  ab ' }, 'reason'],
    [{ scopeRefId: -1 }, 'scopeRefId'],
    [{ effectiveFrom: '25/09/2026' }, 'effectiveFrom'],
  ])('AssignHrRoleDto từ chối %o', async (override, property) => {
    const base = {
      roleCode: 'HR_OFFICER',
      scope: 'COMPANY',
      reason: 'lý do hợp lệ',
    };
    expect(await errorsOf(AssignHrRoleDto, { ...base, ...override })).toContain(
      property,
    );
  });

  it('RevokeHrRoleAssignmentDto bắt buộc version và lý do', async () => {
    expect(await errorsOf(RevokeHrRoleAssignmentDto, {})).toEqual(
      expect.arrayContaining(['reason', 'version']),
    );
    expect(
      await errorsOf(RevokeHrRoleAssignmentDto, {
        reason: 'chuyển bộ phận',
        version: '2',
      }),
    ).toEqual([]);
  });
});
