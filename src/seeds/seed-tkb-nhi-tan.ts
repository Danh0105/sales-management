/**
 * Seed TKB STEM — Tiểu học Nhị Tân, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy của trường: cô Ngô Thị Thuỳ Duyên dạy phần lớn tiết,
 * cô Phan Hân Nghi dạy 5 tiết chiều Thứ 5 và Thứ 6 (cột song song với cô
 * Duyên). Mỗi ô là 1 tiết cho 1 lớp.
 *
 * Bảng có 2 cột song song ở THỨ 4 và THỨ 5 (2 giáo viên dạy cùng khung giờ).
 *
 * Chạy lại được nhiều lần: mọi INSERT đều tra trước theo khoá tự nhiên nên
 * không sinh bản ghi trùng.
 *
 * Chạy: npm run seed:tkb-nhi-tan
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME = 'TIỂU HỌC NHỊ TÂN';
const SCHOOL_YEAR = '2026-2027';
const SUBJECT_NAME = 'STEM';
/** Môn STEM trong danh mục dùng chung. */
const SUBJECT_CATALOG_ID = 14;

/** Khớp với khoảng hiệu lực đang dùng cho phần lớn lịch năm 2026-2027. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Khung giờ từng tiết theo buổi, đúng cột "THỜI GIAN" của bảng TKB. */
const PERIOD_TIME = {
    morning: {
        1: ['07:30', '08:05'],
        2: ['08:10', '08:45'],
        3: ['09:10', '09:45'],
        4: ['09:50', '10:25'],
        5: ['10:30', '11:05'],
    },
    afternoon: {
        1: ['13:30', '14:05'],
        2: ['14:15', '14:50'],
        3: ['15:25', '16:00'],
    },
} as const;

type Session = keyof typeof PERIOD_TIME;

interface Slot {
    teacher: string;
    session: Session;
    period: 1 | 2 | 3 | 4 | 5;
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    className: string;
}

const DUYEN = 'Ngô Thị Thuỳ Duyên';
const NGHI = 'Phan Hân Nghi';

const SLOTS: Slot[] = [
    // ===== SÁNG — cô Duyên, chỉ tiết 3 và 4 =====
    { teacher: DUYEN, session: 'morning', period: 3, dayOfWeek: 4, className: '3A' },
    { teacher: DUYEN, session: 'morning', period: 3, dayOfWeek: 5, className: '1B' },
    { teacher: DUYEN, session: 'morning', period: 3, dayOfWeek: 6, className: '3D' },
    { teacher: DUYEN, session: 'morning', period: 4, dayOfWeek: 4, className: '5E' },
    { teacher: DUYEN, session: 'morning', period: 4, dayOfWeek: 5, className: '5D' },
    { teacher: DUYEN, session: 'morning', period: 4, dayOfWeek: 6, className: '3E' },

    // ===== CHIỀU ===== (Thứ 4 và Thứ 5 có 2 cột song song: cô Duyên và cô Nghi)
    // Tiết 1 — 13:30-14:05
    { teacher: DUYEN, session: 'afternoon', period: 1, dayOfWeek: 2, className: '2D' },
    { teacher: DUYEN, session: 'afternoon', period: 1, dayOfWeek: 3, className: '1A' },
    { teacher: DUYEN, session: 'afternoon', period: 1, dayOfWeek: 4, className: '2C' },
    { teacher: NGHI, session: 'afternoon', period: 1, dayOfWeek: 4, className: '4D' },
    { teacher: DUYEN, session: 'afternoon', period: 1, dayOfWeek: 5, className: '4B' },
    { teacher: NGHI, session: 'afternoon', period: 1, dayOfWeek: 5, className: '5B' },
    { teacher: DUYEN, session: 'afternoon', period: 1, dayOfWeek: 6, className: '1C' },
    // Tiết 2 — 14:15-14:50
    { teacher: DUYEN, session: 'afternoon', period: 2, dayOfWeek: 2, className: '2A' },
    { teacher: DUYEN, session: 'afternoon', period: 2, dayOfWeek: 3, className: '2B' },
    { teacher: DUYEN, session: 'afternoon', period: 2, dayOfWeek: 4, className: '1E' },
    { teacher: NGHI, session: 'afternoon', period: 2, dayOfWeek: 4, className: '5A' },
    { teacher: DUYEN, session: 'afternoon', period: 2, dayOfWeek: 5, className: '4C' },
    { teacher: NGHI, session: 'afternoon', period: 2, dayOfWeek: 5, className: '5C' },
    { teacher: DUYEN, session: 'afternoon', period: 2, dayOfWeek: 6, className: '3C' },
    // Tiết 3 — 15:25-16:00 (cột phụ Thứ 5 trống)
    { teacher: DUYEN, session: 'afternoon', period: 3, dayOfWeek: 2, className: '3B' },
    { teacher: DUYEN, session: 'afternoon', period: 3, dayOfWeek: 3, className: '1G' },
    { teacher: DUYEN, session: 'afternoon', period: 3, dayOfWeek: 4, className: '5G' },
    { teacher: NGHI, session: 'afternoon', period: 3, dayOfWeek: 4, className: '4A' },
    { teacher: DUYEN, session: 'afternoon', period: 3, dayOfWeek: 5, className: '1D' },
    { teacher: DUYEN, session: 'afternoon', period: 3, dayOfWeek: 6, className: '4E' },
];

/** "3A" → khối 3. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className[0]);
    return Number.isFinite(grade) ? grade : null;
}

async function main() {
    const client = new Client(DB);
    await client.connect();

    try {
        await client.query('BEGIN');

        // ===== Trường =====
        const school = await client.query(`SELECT id FROM schools WHERE TRIM(name) = $1`, [
            SCHOOL_NAME,
        ]);
        if (school.rowCount === 0) {
            throw new Error(`Không tìm thấy trường "${SCHOOL_NAME}"`);
        }
        const schoolId: number = school.rows[0].id;
        console.log(`✓ Trường "${SCHOOL_NAME}" (id=${schoolId})`);

        // ===== Giáo viên =====
        const teacherIds = new Map<string, number>();
        for (const name of [DUYEN, NGHI]) {
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
