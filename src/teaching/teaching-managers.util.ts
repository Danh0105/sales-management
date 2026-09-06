import { Repository } from 'typeorm';
import { Employee } from '../employee/employee.entity';
import {
    TEACHER_ACCOUNT_APPROVE_ROLES,
    TEACHING_MANAGE_ROLES,
} from './teaching-roles';

/** Tài khoản Giáo vụ và Nhân sự — người nhận các báo động/thông báo quản lý lịch dạy. */
export function findTeachingManagers(
    employeeRepo: Repository<Employee>,
): Promise<Array<{ id: number; zaloUserId: string | null }>> {
    return findEmployeesByRoles(employeeRepo, TEACHING_MANAGE_ROLES);
}

/** Chỉ Nhân sự — người duyệt hồ sơ mở tài khoản giáo viên. */
export function findTeacherAccountApprovers(
    employeeRepo: Repository<Employee>,
): Promise<Array<{ id: number; zaloUserId: string | null }>> {
    return findEmployeesByRoles(employeeRepo, TEACHER_ACCOUNT_APPROVE_ROLES);
}

async function findEmployeesByRoles(
    employeeRepo: Repository<Employee>,
    roles: string[],
): Promise<Array<{ id: number; zaloUserId: string | null }>> {
    const rows = await employeeRepo
        .createQueryBuilder('e')
        .select('e.id', 'id')
        .addSelect('e.zaloUserId', 'zaloUserId')
        .where('e.roles && ARRAY[:...roles]::text[]', { roles })
        .getRawMany();

    return rows.map((row) => ({
        id: Number(row.id),
        zaloUserId: row.zaloUserId ?? null,
    }));
}
