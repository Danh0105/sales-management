/**
 * Seed TKB STEM — THCS Trần Phú (id 454, Số 1 Cửu Long, Hoà Hưng), năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy: 2 giáo viên, 30 tiết/tuần, mỗi lớp đúng 1 tiết
 * (7 lớp khối 6, 7 lớp khối 7, 8 lớp khối 8, 8 lớp khối 9).
 *  - Dương Hoàng Sơn: toàn bộ 19 tiết sáng + 3 tiết chiều Thứ 4.
 *  - Nguyễn Tấn Hoàng: 8 tiết chiều (Thứ 3, 5, 6).
 *  Bảng gốc không có tiết nào vào Thứ 2.
 *
 * Lưu ý: có HAI trường tên Trần Phú trong `schools` (454 ở Hoà Hưng và 499 ở
 * Tam Thắng) — script chốt theo id để không seed nhầm.
 *
 * Script KHÔNG tạo trường: `schools` phải có sẵn bản ghi (Nhân sự khai trên UI
 * để có toạ độ/bán kính check-in).
 *
 * Chạy lại được nhiều lần: tra trước theo khoá tự nhiên rồi mới INSERT.
 *
 * Chạy: npm run seed:tkb-tran-phu
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

/** Chốt theo id: tên "THCS Trần Phú" bị trùng giữa 2 trường. */
const SCHOOL_ID = 454;
const SCHOOL_YEAR = '2026-2027';

const SUBJECT_NAME = 'STEM';
const SUBJECT_CATALOG_ID = 14;

/** Cùng khoảng hiệu lực với các TKB 2026-2027 khác đang chạy. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Cột "THỜI GIAN" của bảng — số tiết lặp lại giữa sáng và chiều. */
const PERIOD_TIME = {
    morning: {
        1: ['07:15', '08:00'],
        2: ['08:00', '08:45'],
        3: ['09:10', '09:55'],
        4: ['09:55', '10:40'],
        5: ['10:40', '11:25'],
    },
    afternoon: {
        2: ['13:30', '14:15'],
        3: ['14:40', '15:25'],
        4: ['15:25', '16:10'],
    },
} as const;

type Session = keyof typeof PERIOD_TIME;

/** Giáo viên chốt theo id (bảng TKB chỉ ghi tên gọi "Sơn" / "Hoàng"). */
const TEACHERS = {
    SON: { id: 117, name: 'Dương Hoàng Sơn' },
    HOANG: { id: 180, name: 'Nguyễn Tấn Hoàng' },
} as const;

type TeacherKey = keyof typeof TEACHERS;

interface Slot {
    session: Session;
    period: number;
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    className: string;
    teacher: TeacherKey;
}

const SLOTS: Slot[] = [
    // ===== SÁNG — Sơn =====
    // Thứ 3
    { session: 'morning', period: 1, dayOfWeek: 3, className: '9/8', teacher: 'SON' },
    { session: 'morning', period: 2, dayOfWeek: 3, className: '8/3', teacher: 'SON' },
    { session: 'morning', period: 3, dayOfWeek: 3, className: '7/7', teacher: 'SON' },
    { session: 'morning', period: 5, dayOfWeek: 3, className: '7/5', teacher: 'SON' },
    // Thứ 4
    { session: 'morning', period: 1, dayOfWeek: 4, className: '9/1', teacher: 'SON' },
    { session: 'morning', period: 2, dayOfWeek: 4, className: '9/4', teacher: 'SON' },
    { session: 'morning', period: 3, dayOfWeek: 4, className: '9/6', teacher: 'SON' },
    { session: 'morning', period: 4, dayOfWeek: 4, className: '7/2', teacher: 'SON' },
    { session: 'morning', period: 5, dayOfWeek: 4, className: '6/6', teacher: 'SON' },
    // Thứ 5
    { session: 'morning', period: 1, dayOfWeek: 5, className: '8/4', teacher: 'SON' },
    { session: 'morning', period: 2, dayOfWeek: 5, className: '8/8', teacher: 'SON' },
    { session: 'morning', period: 3, dayOfWeek: 5, className: '9/2', teacher: 'SON' },
    { session: 'morning', period: 4, dayOfWeek: 5, className: '9/3', teacher: 'SON' },
    { session: 'morning', period: 5, dayOfWeek: 5, className: '6/5', teacher: 'SON' },
    // Thứ 6
    { session: 'morning', period: 1, dayOfWeek: 6, className: '7/1', teacher: 'SON' },
    { session: 'morning', period: 2, dayOfWeek: 6, className: '8/7', teacher: 'SON' },
    { session: 'morning', period: 3, dayOfWeek: 6, className: '6/3', teacher: 'SON' },
    { session: 'morning', period: 4, dayOfWeek: 6, className: '6/1', teacher: 'SON' },
    { session: 'morning', period: 5, dayOfWeek: 6, className: '6/2', teacher: 'SON' },

    // ===== CHIỀU =====
    // Thứ 3 — Hoàng
    { session: 'afternoon', period: 2, dayOfWeek: 3, className: '9/5', teacher: 'HOANG' },
    { session: 'afternoon', period: 3, dayOfWeek: 3, className: '8/1', teacher: 'HOANG' },
    { session: 'afternoon', period: 4, dayOfWeek: 3, className: '9/7', teacher: 'HOANG' },
    // Thứ 4 — Sơn (dạy cả ngày)
    { session: 'afternoon', period: 2, dayOfWeek: 4, className: '6/4', teacher: 'SON' },
    { session: 'afternoon', period: 3, dayOfWeek: 4, className: '8/5', teacher: 'SON' },
    { session: 'afternoon', period: 4, dayOfWeek: 4, className: '8/2', teacher: 'SON' },
    // Thứ 5 — Hoàng
    { session: 'afternoon', period: 2, dayOfWeek: 5, className: '6/7', teacher: 'HOANG' },
    { session: 'afternoon', period: 3, dayOfWeek: 5, className: '7/6', teacher: 'HOANG' },
    { session: 'afternoon', period: 4, dayOfWeek: 5, className: '7/3', teacher: 'HOANG' },
    // Thứ 6 — Hoàng (không có tiết 2)
    { session: 'afternoon', period: 3, dayOfWeek: 6, className: '7/4', teacher: 'HOANG' },
    { session: 'afternoon', period: 4, dayOfWeek: 6, className: '8/6', teacher: 'HOANG' },
];

/** "9/8" → khối 9. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className.split('/')[0]);
    return Number.isFinite(grade) ? grade : null;
}

async function main() {
    const client = new Client(DB);
    await client.connect();

    try {
        await client.query('BEGIN');

        // ===== Trường (phải có sẵn) =====
        const school = await client.query(`SELECT id, name FROM schools WHERE id = $1`, [
            SCHOOL_ID,
        ]);
        if (school.rowCount === 0) {
            throw new Error(
                `Không tìm thấy trường id=${SCHOOL_ID} trong bảng schools.\n` +
                `→ Nhân sự tạo trường trên UI trước (kèm địa chỉ/toạ độ/bán kính check-in), rồi chạy lại script.`,
            );
        }
        const schoolId: number = school.rows[0].id;
        console.log(`✓ Trường "${school.rows[0].name.trim()}" (id=${schoolId})`);

        // ===== Giáo viên =====
        for (const key of Object.keys(TEACHERS) as TeacherKey[]) {
            const { id, name } = TEACHERS[key];
            const found = await client.query(`SELECT name FROM teachers WHERE id = $1`, [id]);
            if (found.rowCount === 0) {
                throw new Error(`Không tìm thấy giáo viên id=${id} ("${name}")`);
            }
            if (found.rows[0].name !== name) {
                throw new Error(
                    `Giáo viên id=${id} tên "${found.rows[0].name}", không phải "${name}" — id có thể đã bị dùng lại.`,
                );
            }
            console.log(`✓ Giáo viên "${name}" (id=${id})`);
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
            // `code` sinh từ chính id (quy ước SUB<id> như dữ liệu sẵn có).
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
                 WHERE school_id = $1 AND UPPER(TRIM(name)) = UPPER($2) AND school_year = $3
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
            const [startTime, endTime] = (PERIOD_TIME[slot.session] as Record<
                number,
                readonly [string, string]
            >)[slot.period];
            const teacherId = TEACHERS[slot.teacher].id;
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
    console.error('✗ Seed thất bại:', err instanceof Error ? err.message : err);
    process.exit(1);
});
