/**
 * Seed TKB STEM — Trường Tiểu học Trần Văn Ơn, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy: 2 giáo viên, 18 tiết/tuần, mỗi lớp đúng 1 tiết.
 *  - Mỹ Tiên: 3 tiết sáng Thứ 6 (tiết 2, 3, 4).
 *  - Hoàng Diệu: 15 tiết chiều, tiết 3 → 5, Thứ 2 → Thứ 6.
 *
 * Chỉ một môn STEM; tên lớp theo quy ước sẵn có của trường ("4.3", "5.1").
 *
 * Script KHÔNG tạo trường: `schools` phải có sẵn bản ghi (Nhân sự khai trên UI
 * để có toạ độ/bán kính check-in).
 *
 * Chạy lại được nhiều lần: tra trước theo khoá tự nhiên rồi mới INSERT.
 *
 * Chạy: npm run seed:tkb-tran-van-on
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME_LIKE = '%TRẦN VĂN ƠN%';
const SCHOOL_YEAR = '2026-2027';

const SUBJECT_NAME = 'STEM';
const SUBJECT_CATALOG_ID = 14;

/** Cùng khoảng hiệu lực với các TKB 2026-2027 khác đang chạy. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Cột "THỜI GIAN" của bảng — số tiết lặp lại giữa sáng và chiều. */
const PERIOD_TIME = {
    morning: {
        1: ['07:30', '08:05'],
        2: ['08:10', '08:45'],
        3: ['09:20', '09:55'],
        4: ['10:00', '10:35'],
    },
    afternoon: {
        3: ['14:10', '14:45'],
        4: ['14:50', '15:25'],
        5: ['15:30', '16:05'],
    },
} as const;

type Session = keyof typeof PERIOD_TIME;

/** Giáo viên chốt theo id (tên trong DB dài hơn tên gọi trong bảng TKB). */
const TEACHERS = {
    HOANG_DIEU: { id: 77, name: 'Nguyễn Thị Hoàng Diệu' },
    MY_TIEN: { id: 161, name: 'Nguyễn Ngọc Mỹ Tiên' },
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
    // ===== SÁNG — Mỹ Tiên, chỉ Thứ 6 =====
    { session: 'morning', period: 2, dayOfWeek: 6, className: '5.1', teacher: 'MY_TIEN' },
    { session: 'morning', period: 3, dayOfWeek: 6, className: '5.5', teacher: 'MY_TIEN' },
    { session: 'morning', period: 4, dayOfWeek: 6, className: '5.4', teacher: 'MY_TIEN' },

    // ===== CHIỀU — Hoàng Diệu =====
    // Tiết 3 (14:10 - 14:45)
    { session: 'afternoon', period: 3, dayOfWeek: 2, className: '4.3', teacher: 'HOANG_DIEU' },
    { session: 'afternoon', period: 3, dayOfWeek: 3, className: '4.7', teacher: 'HOANG_DIEU' },
    { session: 'afternoon', period: 3, dayOfWeek: 4, className: '5.8', teacher: 'HOANG_DIEU' },
    { session: 'afternoon', period: 3, dayOfWeek: 5, className: '5.6', teacher: 'HOANG_DIEU' },
    { session: 'afternoon', period: 3, dayOfWeek: 6, className: '4.9', teacher: 'HOANG_DIEU' },

    // Tiết 4 (14:50 - 15:25)
    { session: 'afternoon', period: 4, dayOfWeek: 2, className: '4.2', teacher: 'HOANG_DIEU' },
    { session: 'afternoon', period: 4, dayOfWeek: 3, className: '4.8', teacher: 'HOANG_DIEU' },
    { session: 'afternoon', period: 4, dayOfWeek: 4, className: '5.7', teacher: 'HOANG_DIEU' },
    { session: 'afternoon', period: 4, dayOfWeek: 5, className: '5.9', teacher: 'HOANG_DIEU' },
    { session: 'afternoon', period: 4, dayOfWeek: 6, className: '4.5', teacher: 'HOANG_DIEU' },

    // Tiết 5 (15:30 - 16:05)
    { session: 'afternoon', period: 5, dayOfWeek: 2, className: '4.4', teacher: 'HOANG_DIEU' },
    { session: 'afternoon', period: 5, dayOfWeek: 3, className: '4.6', teacher: 'HOANG_DIEU' },
    { session: 'afternoon', period: 5, dayOfWeek: 4, className: '5.3', teacher: 'HOANG_DIEU' },
    { session: 'afternoon', period: 5, dayOfWeek: 5, className: '5.2', teacher: 'HOANG_DIEU' },
    { session: 'afternoon', period: 5, dayOfWeek: 6, className: '4.1', teacher: 'HOANG_DIEU' },
];

/** "4.3" → khối 4. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className.split('.')[0]);
    return Number.isFinite(grade) ? grade : null;
}

async function main() {
    const client = new Client(DB);
    await client.connect();

    try {
        await client.query('BEGIN');

        // ===== Trường (phải có sẵn) =====
        const school = await client.query(
            `SELECT id, name FROM schools WHERE name ILIKE $1`,
            [SCHOOL_NAME_LIKE],
        );
        if (school.rowCount === 0) {
            throw new Error(
                `Chưa có trường khớp "${SCHOOL_NAME_LIKE}" trong bảng schools.\n` +
                `→ Nhân sự tạo trường trên UI trước (kèm địa chỉ/toạ độ/bán kính check-in), rồi chạy lại script.`,
            );
        }
        if (school.rowCount! > 1) {
            throw new Error(
                `Có ${school.rowCount} trường khớp "${SCHOOL_NAME_LIKE}": ` +
                school.rows.map((r) => `${r.id}=${r.name}`).join(', '),
            );
        }
        const schoolId: number = school.rows[0].id;
        console.log(`✓ Trường "${school.rows[0].name}" (id=${schoolId})`);

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
