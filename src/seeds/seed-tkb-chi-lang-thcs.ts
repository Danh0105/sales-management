/**
 * Seed TKB KNS — THCS Chi Lăng, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy của trường: buổi chiều, mỗi ô là 1 tiết cho 1 lớp.
 * Mỗi ngày có tối đa 3 cột song song (3 giáo viên dạy cùng khung giờ ở 3 lớp).
 * Bảng gốc chỉ có dữ liệu Thứ 2 và Thứ 3.
 *
 * Lưu ý: đây là trường THCS Chi Lăng (id 441), khác với TIỂU HỌC CHI LĂNG
 * trong seed-tkb-chi-lang.ts.
 *
 * Chạy lại được nhiều lần: mọi INSERT đều tra trước theo khoá tự nhiên
 * (lớp theo school+name+year, lịch theo teacher+class+subject+day+start_time)
 * nên không sinh bản ghi trùng.
 *
 * Chạy: npm run seed:tkb-chi-lang-thcs
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME = 'THCS Chi Lăng';
const SCHOOL_YEAR = '2026-2027';
const SUBJECT_NAME = 'KNS';
/** Môn trong danh mục dùng chung. */
const SUBJECT_CATALOG_ID = 20;

/** Khớp với khoảng hiệu lực đang dùng cho phần lớn lịch năm 2026-2027. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Khung giờ từng tiết buổi chiều, đúng cột "THỜI GIAN" của bảng TKB. */
const PERIOD_TIME = {
    afternoon: {
        1: ['13:30', '14:15'],
        2: ['14:15', '15:00'],
        3: ['15:30', '16:15'],
        4: ['16:15', '17:00'],
    },
} as const;

type Session = keyof typeof PERIOD_TIME;

interface Slot {
    teacher: string;
    session: Session;
    period: 1 | 2 | 3 | 4;
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    className: string;
}

const PHUC = 'Trương Ngọc Phúc';
const CHAU = 'Lê Nguyễn Thảo Châu';
const HIEN = 'Nguyễn Thị Hiền';

const SLOTS: Slot[] = [
    // ===== THỨ 2 =====
    // Tiết 3 — 15:30-16:15
    { teacher: PHUC, session: 'afternoon', period: 3, dayOfWeek: 2, className: '8A5' },
    { teacher: CHAU, session: 'afternoon', period: 3, dayOfWeek: 2, className: '8A3' },
    { teacher: HIEN, session: 'afternoon', period: 3, dayOfWeek: 2, className: '7A4' },
    // Tiết 4 — 16:15-17:00
    { teacher: PHUC, session: 'afternoon', period: 4, dayOfWeek: 2, className: '8A4' },
    { teacher: CHAU, session: 'afternoon', period: 4, dayOfWeek: 2, className: '7A5' },
    { teacher: HIEN, session: 'afternoon', period: 4, dayOfWeek: 2, className: '7A3' },

    // ===== THỨ 3 =====
    // Tiết 2 — 14:15-15:00
    { teacher: HIEN, session: 'afternoon', period: 2, dayOfWeek: 3, className: '7A6' },
    // Tiết 3 — 15:30-16:15
    { teacher: PHUC, session: 'afternoon', period: 3, dayOfWeek: 3, className: '8A8' },
    { teacher: CHAU, session: 'afternoon', period: 3, dayOfWeek: 3, className: '8A2' },
    // Tiết 4 — 16:15-17:00
    { teacher: PHUC, session: 'afternoon', period: 4, dayOfWeek: 3, className: '7A1' },
    { teacher: CHAU, session: 'afternoon', period: 4, dayOfWeek: 3, className: '8A1' },
    { teacher: HIEN, session: 'afternoon', period: 4, dayOfWeek: 3, className: '7A2' },
];

/** "7A4" → khối 7. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className.match(/^\d+/)?.[0]);
    return Number.isFinite(grade) ? grade : null;
}

async function main() {
    const client = new Client(DB);
    await client.connect();

    try {
        await client.query('BEGIN');

        // ===== Trường =====
        const school = await client.query(`SELECT id FROM schools WHERE name = $1`, [
            SCHOOL_NAME,
        ]);
        if (school.rowCount === 0) {
            throw new Error(`Không tìm thấy trường "${SCHOOL_NAME}"`);
        }
        const schoolId: number = school.rows[0].id;
        console.log(`✓ Trường "${SCHOOL_NAME}" (id=${schoolId})`);

        // ===== Giáo viên =====
        const teacherIds = new Map<string, number>();
        for (const name of [PHUC, CHAU, HIEN]) {
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
                 WHERE school_id = $1 AND name = $2 AND school_year = $3`,
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
                    `TKB ${SCHOOL_YEAR} — tiết ${slot.period} chiều`,
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
