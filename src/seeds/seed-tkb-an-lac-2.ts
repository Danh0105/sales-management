/**
 * Seed TKB STEM — Trường Tiểu học An Lạc 2, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy: một giáo viên duy nhất (Nguyễn Thị Như Thảo) dạy 21 lớp
 * trong 21 tiết/tuần, mỗi lớp đúng 1 tiết. Sáng chỉ có Thứ 2 (tiết 3, 4) và
 * Thứ 6 (tiết 1 → 4); chiều đủ Thứ 2 → Thứ 6, mỗi ngày 3 tiết (5, 6, 7).
 *
 * Script KHÔNG tạo trường: `schools` phải có sẵn bản ghi trường này (Nhân sự
 * khai trên UI để có địa chỉ/toạ độ/bán kính check-in).
 *
 * Chạy lại được nhiều lần: tra trước theo khoá tự nhiên rồi mới INSERT.
 *
 * Chạy: npm run seed:tkb-an-lac-2
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

/** Khớp lỏng theo từ khoá — trong DB tên là "TIỂU HỌC AN LẠC 2". */
const SCHOOL_NAME_LIKE = '%AN LẠC 2%';
const SCHOOL_YEAR = '2026-2027';
/** Trùng tên môn đã có sẵn của trường này (chữ thường) để không tạo bản trùng. */
const SUBJECT_NAME = 'stem';
const SUBJECT_CATALOG_ID = 14;

const TEACHER_ID = 34;
const TEACHER_NAME = 'Nguyễn Thị Như Thảo';

const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Khung giờ từng tiết, đúng cột "THỜI GIAN" của bảng TKB (tiết 1-4 sáng, 5-7 chiều). */
const PERIOD_TIME: Record<number, readonly [string, string]> = {
    1: ['07:30', '08:05'],
    2: ['08:10', '08:45'],
    3: ['09:20', '09:55'],
    4: ['10:00', '10:35'],
    5: ['14:25', '15:00'],
    6: ['15:05', '15:40'],
    7: ['15:45', '16:20'],
};

interface Slot {
    period: number;
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    className: string;
}

const SLOTS: Slot[] = [
    // ===== SÁNG =====
    { period: 1, dayOfWeek: 6, className: '4.1' },
    { period: 2, dayOfWeek: 6, className: '5.5' },

    { period: 3, dayOfWeek: 2, className: '1.2' },
    { period: 3, dayOfWeek: 6, className: '5.4' },

    { period: 4, dayOfWeek: 2, className: '1.3' },
    { period: 4, dayOfWeek: 6, className: '5.6' },

    // ===== CHIỀU =====
    { period: 5, dayOfWeek: 2, className: '2.1' },
    { period: 5, dayOfWeek: 3, className: '3.2' },
    { period: 5, dayOfWeek: 4, className: '4.3' },
    { period: 5, dayOfWeek: 5, className: '5.3' },
    { period: 5, dayOfWeek: 6, className: '2.3' },

    { period: 6, dayOfWeek: 2, className: '2.2' },
    { period: 6, dayOfWeek: 3, className: '3.3' },
    { period: 6, dayOfWeek: 4, className: '4.2' },
    { period: 6, dayOfWeek: 5, className: '5.2' },
    { period: 6, dayOfWeek: 6, className: '1.4' },

    { period: 7, dayOfWeek: 2, className: '1.1' },
    { period: 7, dayOfWeek: 3, className: '3.1' },
    { period: 7, dayOfWeek: 4, className: '4.4' },
    { period: 7, dayOfWeek: 5, className: '5.1' },
    { period: 7, dayOfWeek: 6, className: '1.5' },
];

/** "4.2" → khối 4, "5.3" → khối 5. */
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
        const teacher = await client.query(`SELECT name FROM teachers WHERE id = $1`, [
            TEACHER_ID,
        ]);
        if (teacher.rowCount === 0) {
            throw new Error(`Không tìm thấy giáo viên id=${TEACHER_ID}`);
        }
        if (teacher.rows[0].name !== TEACHER_NAME) {
            throw new Error(
                `Giáo viên id=${TEACHER_ID} tên "${teacher.rows[0].name}", không phải "${TEACHER_NAME}" — id có thể đã bị dùng lại.`,
            );
        }
        console.log(`✓ Giáo viên "${TEACHER_NAME}" (id=${TEACHER_ID})`);

        // ===== Môn học =====
        let subject = await client.query(
            `SELECT id FROM subjects
             WHERE school_id = $1 AND name = $2 AND school_year = $3`,
            [schoolId, SUBJECT_NAME, SCHOOL_YEAR],
        );
        if (subject.rowCount === 0) {
            subject = await client.query(
                `INSERT INTO subjects (name, school_id, school_year, catalog_id)
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [SUBJECT_NAME, schoolId, SCHOOL_YEAR, SUBJECT_CATALOG_ID],
            );
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
                 WHERE school_id = $1 AND name = $2 AND school_year = $3
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
        await client.query(`UPDATE subjects SET class_count = $1 WHERE id = $2`, [
            classNames.length,
            subjectId,
        ]);

        // ===== Mẫu lịch =====
        let created = 0;
        let skipped = 0;
        for (const slot of SLOTS) {
            const [startTime, endTime] = PERIOD_TIME[slot.period];
            const classId = classIds.get(slot.className)!;

            const existing = await client.query(
                `SELECT id FROM teaching_schedules
                 WHERE teacher_id = $1 AND class_id = $2 AND subject_id = $3
                   AND day_of_week = $4 AND start_time = $5`,
                [TEACHER_ID, classId, subjectId, slot.dayOfWeek, startTime],
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
                    TEACHER_ID,
                    schoolId,
                    classId,
                    subjectId,
                    slot.dayOfWeek,
                    startTime,
                    endTime,
                    EFFECTIVE_FROM,
                    EFFECTIVE_TO,
                    `TKB ${SCHOOL_YEAR} — tiết ${slot.period} ${slot.period <= 4 ? 'sáng' : 'chiều'}`,
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
