/**
 * Seed cho module giảng dạy:
 *   - Phòng ban "Nhân sự" (department)
 *   - User role `nhansu` (phòng Nhân sự) và `giaovien_congty` (giáo viên công ty)
 *   - Hồ sơ teacher gắn với tài khoản giáo viên vừa tạo
 *
 * Chạy: npm run seed:teaching-users
 * (user đã tồn tại theo email → chỉ bổ sung role còn thiếu, không đổi mật khẩu)
 */
import { Client } from 'pg';
import * as bcrypt from 'bcrypt';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const HR_DEPARTMENT = { name: 'Nhân sự', icon: '🧑‍💼' };

const USERS: {
    name: string;
    email: string;
    phone: string;
    roles: string[];
    /** true = tạo luôn hồ sơ giáo viên gắn với tài khoản này. */
    asTeacher?: boolean;
    inHrDepartment?: boolean;
}[] = [
        {
            name: 'Nhân sự (test)',
            email: 'nhansu@test.local',
            phone: '0900000007',
            roles: ['nhansu'],
            inHrDepartment: true,
        },
        {
            name: 'Giáo viên A (test)',
            email: 'giaovien.a@test.local',
            phone: '0900000008',
            roles: ['giaovien_congty'],
            asTeacher: true,
        },
        {
            name: 'Giáo viên B (test)',
            email: 'giaovien.b@test.local',
            phone: '0900000009',
            roles: ['giaovien_congty'],
            asTeacher: true,
        },
    ];

const DEFAULT_PASSWORD = '123456';

async function main() {
    const client = new Client(DB);
    await client.connect();

    try {
        const password = await bcrypt.hash(DEFAULT_PASSWORD, 10);

        // ===== Phòng ban Nhân sự =====
        const dept = await client.query(
            `INSERT INTO department (name, icon) VALUES ($1, $2)
             ON CONFLICT (name) DO UPDATE SET icon = EXCLUDED.icon
             RETURNING id`,
            [HR_DEPARTMENT.name, HR_DEPARTMENT.icon],
        );
        const hrDepartmentId = dept.rows[0].id;
        console.log(`✓ Phòng ban "${HR_DEPARTMENT.name}" (id=${hrDepartmentId})`);

        for (const user of USERS) {
            const existing = await client.query(
                `SELECT id, roles FROM employee WHERE email = $1`,
                [user.email],
            );

            let employeeId: number;

            if (existing.rowCount) {
                employeeId = existing.rows[0].id;
                const current: string[] = existing.rows[0].roles ?? [];
                const merged = [...new Set([...current, ...user.roles])];

                await client.query(
                    `UPDATE employee SET roles = $1::text[], department_id = COALESCE($2, department_id)
                     WHERE id = $3`,
                    [merged, user.inHrDepartment ? hrDepartmentId : null, employeeId],
                );

                console.log(
                    `~ ${user.email} đã tồn tại → roles = [${merged.join(', ')}]`,
                );
            } else {
                const inserted = await client.query(
                    `INSERT INTO employee (name, email, phone, password, roles, "isActive", department_id)
                     VALUES ($1, $2, $3, $4, $5::text[], true, $6)
                     RETURNING id`,
                    [
                        user.name,
                        user.email,
                        user.phone,
                        password,
                        user.roles,
                        user.inHrDepartment ? hrDepartmentId : null,
                    ],
                );

                employeeId = inserted.rows[0].id;

                console.log(
                    `+ Tạo ${user.email} (id=${employeeId}, phone=${user.phone}, ` +
                    `roles=[${user.roles.join(', ')}], password=${DEFAULT_PASSWORD})`,
                );
            }

            // ===== Hồ sơ giáo viên gắn tài khoản =====
            if (user.asTeacher) {
                const teacher = await client.query(
                    `INSERT INTO teachers (name, phone, email, employee_id, is_active)
                     VALUES ($1, $2, $3, $4, true)
                     ON CONFLICT (employee_id) DO UPDATE SET name = EXCLUDED.name
                     RETURNING id`,
                    [user.name, user.phone, user.email, employeeId],
                );

                console.log(
                    `  └ hồ sơ giáo viên id=${teacher.rows[0].id} ← employee ${employeeId}`,
                );
            }
        }

        console.log('\nSeed xong. Đăng nhập bằng phone + mật khẩu 123456.');
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error('Seed thất bại:', err);
    process.exit(1);
});
