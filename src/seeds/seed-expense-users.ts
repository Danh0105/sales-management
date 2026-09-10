/**
 * Seed các user cho quy trình đề xuất chi:
 *   sales, director, ketoan_congno, thuquy, saleadmin, ketoan_truong, ky_thuat
 *
 * ketoan_truong (Kế toán trưởng) = vai trò CHỈ XEM: Quản lý thu chi, Thống kê,
 *   Đề xuất chi, Chính sách.
 *
 * Chạy: npm run seed:expense-users
 * (user đã tồn tại theo email → chỉ bổ sung role còn thiếu)
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

const USERS: {
    name: string;
    email: string;
    phone: string;
    roles: string[];
}[] = [
    {
        name: 'Kinh doanh (test)',
        email: 'sales.expense@test.local',
        phone: '0900000001',
        roles: ['sales'],
    },
    {
        name: 'Giám đốc (test)',
        email: 'director.expense@test.local',
        phone: '0900000002',
        roles: ['director'],
    },
    {
        name: 'Kế toán công nợ (test)',
        email: 'ketoan.congno.expense@test.local',
        phone: '0900000003',
        roles: ['ketoan_congno'],
    },
    {
        name: 'Thủ quỹ (test)',
        email: 'thuquy.expense@test.local',
        phone: '0900000004',
        roles: ['thuquy'],
    },
    {
        name: 'Sales Admin (test)',
        email: 'saleadmin.expense@test.local',
        phone: '0900000005',
        roles: ['saleadmin'],
    },
    {
        name: 'Kế toán trưởng (test)',
        email: 'ketoan.truong.expense@test.local',
        phone: '0900000006',
        roles: ['ketoan_truong'],
    },
    {
        name: 'Phòng kỹ thuật (test)',
        email: 'kythuat.expense@test.local',
        phone: '0900000007',
        roles: ['ky_thuat'],
    },
];

const DEFAULT_PASSWORD = '123456';

async function main() {
    const client = new Client(DB);
    await client.connect();

    try {
        const password = await bcrypt.hash(DEFAULT_PASSWORD, 10);

        for (const user of USERS) {
            const existing = await client.query(
                `SELECT id, roles FROM employee WHERE email = $1`,
                [user.email],
            );

            if (existing.rowCount) {
                const current: string[] = existing.rows[0].roles ?? [];
                const merged = [...new Set([...current, ...user.roles])];

                await client.query(
                    `UPDATE employee SET roles = $1::text[] WHERE id = $2`,
                    [merged, existing.rows[0].id],
                );

                console.log(
                    `~ ${user.email} đã tồn tại → roles = [${merged.join(', ')}]`,
                );
                continue;
            }

            const inserted = await client.query(
                `INSERT INTO employee (name, email, phone, password, roles, "isActive")
                 VALUES ($1, $2, $3, $4, $5::text[], true)
                 RETURNING id`,
                [user.name, user.email, user.phone, password, user.roles],
            );

            console.log(
                `+ Tạo ${user.email} (id=${inserted.rows[0].id}, phone=${user.phone}, ` +
                `roles=[${user.roles.join(', ')}], password=${DEFAULT_PASSWORD})`,
            );
        }

        console.log('Seed xong.');
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error('Seed thất bại:', err);
    process.exit(1);
});
