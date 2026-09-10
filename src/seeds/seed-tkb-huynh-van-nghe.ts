/**
 * Seed TKB STEM — THCS Huỳnh Văn Nghệ, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy của trường: cô Lê Thị Ngọc Ánh (phần lớn tiết), thầy
 * Bùi Bảo Tín (chiều Thứ 2) và cô Nguyễn Ngô Mỹ Ngân (chiều Thứ 3).
 * Mỗi ô là 1 tiết cho 1 lớp.
 *
 * Trường chưa có trong DB nên script tạo luôn hồ sơ trường (chưa có địa chỉ,
 * toạ độ, nhân viên phụ trách — bổ sung sau trên app), rồi tới môn, lớp, lịch.
 * Trường dùng tên lớp kiểu "7.1"; ô "7/6" trong bảng được hiểu là lớp 7.6.
 *
 * Chạy lại được nhiều lần: mọi INSERT đều tra trước theo khoá tự nhiên nên
 * không sinh bản ghi trùng.
 *
 * Chạy: npm run seed:tkb-huynh-van-nghe
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME = 'THCS Huỳnh Văn Nghệ';
const SCHOOL_YEAR = '2026-2027';
const SUBJECT_NAME = 'STEM';
/** Môn STEM trong danh mục dùng chung, như các trường STEM khác năm 2026-2027. */
const SUBJECT_CATALOG_ID = 14;

/** Khớp với khoảng hiệu lực đang dùng cho phần lớn lịch năm 2026-2027. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Khung giờ từng tiết theo buổi, đúng cột "THỜI GIAN" của bảng TKB. */
const PERIOD_TIME = {
    morning: {
        1: ['07:15', '08:00'],
        2: ['08:00', '08:45'],
        3: ['09:15', '10:00'],
        4: ['10:00', '10:45'],
        5: ['10:45', '11:30'],
    },
    afternoon: {
        1: ['12:30', '13:15'],
        2: ['13:15', '14:00'],
        3: ['14:00', '14:45'],
        4: ['15:15', '16:00'],
        5: ['16:00', '16:45'],
    },
} as const;

type Session = keyof typeof PERIOD_TIME;

interface Slot {
    teacher: string;
    session: Session;
    period: 1 | 2 | 3 | 4 | 5;
    /** 2 = Thứ Hai … 7 = Thứ Bảy. */
    dayOfWeek: number;
    className: string;
}

const ANH = 'Lê Thị Ngọc Ánh';
const TIN = 'Bùi Bảo Tín';
const NGAN = 'Nguyễn Ngô Mỹ Ngân';

const SLOTS: Slot[] = [
    // ===== SÁNG — cô Ánh (tiết 3, 4 trống) =====
    { teacher: ANH, session: 'morning', period: 1, dayOfWeek: 4, className: '8.6' },
    { teacher: ANH, session: 'morning', period: 1, dayOfWeek: 5, className: '8.8' },
    { teacher: ANH, session: 'morning', period: 1, dayOfWeek: 6, className: '8.7' },
    { teacher: ANH, session: 'morning', period: 2, dayOfWeek: 4, className: '8.10' },
    { teacher: ANH, session: 'morning', period: 2, dayOfWeek: 5, className: '8.5' },
    { teacher: ANH, session: 'morning', period: 2, dayOfWeek: 6, className: '8.9' },
    { teacher: ANH, session: 'morning', period: 5, dayOfWeek: 4, className: '7.1' },

    // ===== CHIỀU ===== (thầy Tín giữ trọn chiều Thứ 2, cô Ngân chiều Thứ 3)
    // Tiết 2 — 13:15-14:00
    { teacher: TIN, session: 'afternoon', period: 2, dayOfWeek: 2, className: '7.6' },
    // Tiết 3 — 14:00-14:45
    { teacher: TIN, session: 'afternoon', period: 3, dayOfWeek: 2, className: '7.5' },
    { teacher: NGAN, session: 'afternoon', period: 3, dayOfWeek: 3, className: '8.3' },
    { teacher: ANH, session: 'afternoon', period: 3, dayOfWeek: 5, className: '7.2' },
    // Tiết 4 — 15:15-16:00
    { teacher: TIN, session: 'afternoon', period: 4, dayOfWeek: 2, className: '7.9' },
    { teacher: NGAN, session: 'afternoon', period: 4, dayOfWeek: 3, className: '8.1' },
    { teacher: ANH, session: 'afternoon', period: 4, dayOfWeek: 5, className: '7.7' },
    { teacher: ANH, session: 'afternoon', period: 4, dayOfWeek: 6, className: '7.8' },
    { teacher: ANH, session: 'afternoon', period: 4, dayOfWeek: 7, className: '7.4' },
    // Tiết 5 — 16:00-16:45
    { teacher: TIN, session: 'afternoon', period: 5, dayOfWeek: 2, className: '7.3' },
    { teacher: NGAN, session: 'afternoon', period: 5, dayOfWeek: 3, className: '8.2' },
    { teacher: ANH, session: 'afternoon', period: 5, dayOfWeek: 4, className: '8.4' },
    { teacher: ANH, session: 'afternoon', period: 5, dayOfWeek: 7, className: '7.10' },
];

/** "7.10" → khối 7. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className.split('.')[0]);
    return Number.isFinite(grade) ? grade : null;
}

async function main() {
    const client = new Client(DB);
    await client.connect();

    try {
        await client.query('BEGIN');

        // ===== Trường =====
        let school = await client.query(`SELECT id FROM schools WHERE TRIM(name) = $1`, [
            SCHOOL_NAME,
        ]);
        if (school.rowCount === 0) {
            school = await client.query(
                `INSERT INTO schools (name) VALUES ($1) RETURNING id`,
                [SCHOOL_NAME],
            );
            console.log(
                `+ Trường "${SCHOOL_NAME}" (id=${school.rows[0].id}) — chưa có địa chỉ/toạ độ/NV phụ trách`,
            );
        } else if (school.rowCount! > 1) {
            throw new Error(`Có ${school.rowCount} trường trùng tên "${SCHOOL_NAME}"`);
        } else {
            console.log(`· Trường "${SCHOOL_NAME}" đã có (id=${school.rows[0].id})`);
        }
        const schoolId: number = school.rows[0].id;

        // ===== Giáo viên =====
        const teacherIds = new Map<string, number>();
        for (const name of [ANH, TIN, NGAN]) {
            const found = await client.query(`SELECT id FROM teachers WHERE name = $1`, [
                name,
            ]);
            if (found.rowCount === 0) {
                throw new Error(`Không tìm thấy giáo viên "${name}"`);
            }
            if (found.rowCount! > 1) {
                throw new Error(`Có ${found.rowCount} giáo viên trùng tên "${name}"`);
            }
            teacherIds.set(name, found.rows[0].id);
            console.log(`✓ Giáo viên "${name}" (id=${found.rows[0].id})`);
        }

        // ===== Môn học ===== (TRIM: dữ liệu cũ có tên môn dư khoảng trắng)
        let subject = await client.query(
            `SELECT id FROM subjects
             WHERE school_id = $1 AND TRIM(name) = $2 AND school_year = $3
             ORDER BY id`,
            [schoolId, SUBJECT_NAME, SCHOOL_YEAR],
        );
        if (subject.rowCount === 0) {
            subject = await client.query(
                `INSERT INTO subjects (name, school_id, school_year, catalog_id)
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [SUBJECT_NAME, schoolId, SCHOOL_YEAR, SUBJECT_CATALOG_ID],
            );
            // `code` được sinh từ chính id (quy ước SUB<id> như dữ liệu sẵn có).
            await client.query(`UPDATE subjects SET code = $1 WHERE id = $2`, [
                `SUB${subject.rows[0].id}`,
                subject.rows[0].id,
            ]);
            console.log(`+ Môn "${SUBJECT_NAME}" ${SCHOOL_YEAR} (id=${subject.rows[0].id})`);
        } else {
            console.log(`· Môn "${SUBJECT_NAME}" ${SCHOOL_YEAR} đã có (id=${subject.rows[0].id})`);
        }
        const subjectId: number = subject.rows[0].id;

        // ===== Lớp học =====
        const classNames = [...new Set(SLOTS.map((s) => s.className))];
        const classIds = new Map<string, number>();
        for (const name of classNames) {
            let cls = await client.query(
                `SELECT id FROM school_classes
                 WHERE school_id = $1 AND UPPER(name) = $2 AND school_year = $3
                   AND school_location_id IS NULL`,
                [schoolId, name, SCHOOL_YEAR],
            );
            if (cls.rowCount === 0) {
                cls = await client.query(
                    `INSERT INTO school_classes (school_id, name, grade_level, school_year)
                     VALUES ($1, $2, $3, $4) RETURNING id`,
                    [schoolId, name, gradeLevelOf(name), SCHOOL_YEAR],
                );
                console.log(`+ Lớp ${name} (id=${cls.rows[0].id})`);
            }
            const classId: number = cls.rows[0].id;
            classIds.set(name, classId);

            await client.query(
                `INSERT INTO school_class_subjects (class_id, subject_id)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [classId, subjectId],
            );
        }
        await client.query(
            `UPDATE subjects
             SET class_count = (SELECT count(*) FROM school_class_subjects WHERE subject_id = $1)
             WHERE id = $1`,
            [subjectId],
        );
        await client.query(
            `UPDATE schools
             SET class_count = (SELECT count(*) FROM school_classes
                                WHERE school_id = $1 AND school_year = $2)
             WHERE id = $1`,
            [schoolId, SCHOOL_YEAR],
        );

        // ===== Mẫu lịch =====
        let created = 0;
        let skipped = 0;
        for (const slot of SLOTS) {
            const [startTime, endTime] = PERIOD_TIME[slot.session][slot.period];
            const teacherId = teacherIds.get(slot.teacher)!;
            const classId = classIds.get(slot.className)!;

            const existing = await client.query(
                `SELECT id FROM teaching_schedules
                 WHERE teacher_id = $1 AND class_id = $2 AND subject_id = $3
                   AND day_of_week = $4 AND start_time = $5`,
                [teacherId, classId, subjectId, slot.dayOfWeek, startTime],
            );
            if (existing.rowCount! > 0) {
                skipped++;
                continue;
            }

            await client.query(
                `INSERT INTO teaching_schedules
                   (teacher_id, school_id, class_id, subject_id, day_of_week,
                    start_time, end_time, periods, effective_from, effective_to,
                    is_active, note)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, true, $10)`,
                [
                    teacherId,
                    schoolId,
                    classId,
                    subjectId,
                    slot.dayOfWeek,
                    startTime,
                    endTime,
                    EFFECTIVE_FROM,
                    EFFECTIVE_TO,
                    `TKB ${SCHOOL_YEAR} — tiết ${slot.period} ${slot.session === 'morning' ? 'sáng' : 'chiều'}`,
                ],
            );
            created++;
        }

        await client.query('COMMIT');
        console.log(
            `✓ Xong: ${created} mẫu lịch mới, ${skipped} đã có sẵn (tổng ${SLOTS.length} tiết/tuần).`,
        );
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error('✗ Seed thất bại:', err);
    process.exit(1);
});
