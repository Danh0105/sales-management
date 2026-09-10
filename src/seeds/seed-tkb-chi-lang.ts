/**
 * Seed TKB CDS — Tiểu học Chi Lăng, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy của trường: cô Phan Hân Nghi và cô Lê Thị Anh Thư,
 * mỗi ô là 1 tiết cho 1 lớp. Thứ 3 và Thứ 6 có 2 cột song song (2 giáo viên
 * dạy cùng khung giờ ở 2 lớp khác nhau).
 *
 * Trường chưa khai cơ sở nên lớp/lịch để school_location_id = NULL.
 *
 * Chạy lại được nhiều lần: mọi INSERT đều tra trước theo khoá tự nhiên
 * (lớp theo school+name+year, lịch theo teacher+class+subject+day+start_time)
 * nên không sinh bản ghi trùng.
 *
 * Chạy: npm run seed:tkb-chi-lang
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME = 'TIỂU HỌC CHI LĂNG';
const SCHOOL_YEAR = '2026-2027';
const SUBJECT_NAME = 'CDS';
/** Môn trong danh mục dùng chung — theo môn CDS đã có sẵn của trường này. */
const SUBJECT_CATALOG_ID = 3;

/** Khớp với khoảng hiệu lực đang dùng cho phần lớn lịch năm 2026-2027. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Khung giờ từng tiết theo buổi, đúng cột "THỜI GIAN" của bảng TKB. */
const PERIOD_TIME = {
    morning: {
        1: ['07:30', '08:05'],
        2: ['08:10', '08:45'],
        3: ['09:20', '09:55'],
        4: ['10:00', '10:35'],
        5: ['10:35', '11:10'],
    },
    afternoon: {
        1: ['13:30', '14:05'],
        2: ['14:05', '14:40'],
        3: ['15:00', '15:35'],
        4: ['15:40', '16:30'],
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

const NGHI = 'Phan Hân Nghi';
const THU = 'Lê Thị Anh Thư';

const SLOTS: Slot[] = [
    // ===== SÁNG =====
    // Tiết 1 — 7:30-8:05
    { teacher: NGHI, session: 'morning', period: 1, dayOfWeek: 3, className: '3/4' },
    { teacher: NGHI, session: 'morning', period: 1, dayOfWeek: 4, className: '5/2' },
    { teacher: NGHI, session: 'morning', period: 1, dayOfWeek: 5, className: '4/4' },
    { teacher: NGHI, session: 'morning', period: 1, dayOfWeek: 6, className: '2/5' },
    // Tiết 2 — 8:10-8:45
    { teacher: THU, session: 'morning', period: 2, dayOfWeek: 2, className: '5/5' },
    { teacher: NGHI, session: 'morning', period: 2, dayOfWeek: 3, className: '3/2' },
    { teacher: NGHI, session: 'morning', period: 2, dayOfWeek: 4, className: '2/2' },
    { teacher: NGHI, session: 'morning', period: 2, dayOfWeek: 5, className: '2/4' },
    { teacher: NGHI, session: 'morning', period: 2, dayOfWeek: 6, className: '2/6' },
    // Tiết 3 — 9:20-9:55
    { teacher: THU, session: 'morning', period: 3, dayOfWeek: 2, className: '2/3' },
    { teacher: NGHI, session: 'morning', period: 3, dayOfWeek: 3, className: '3/3' },
    { teacher: NGHI, session: 'morning', period: 3, dayOfWeek: 4, className: '4/3' },
    { teacher: NGHI, session: 'morning', period: 3, dayOfWeek: 5, className: '3/1' },
    { teacher: NGHI, session: 'morning', period: 3, dayOfWeek: 6, className: '1/2' },
    // Tiết 4 — 10:00-10:35
    { teacher: THU, session: 'morning', period: 4, dayOfWeek: 2, className: '3/5' },
    { teacher: NGHI, session: 'morning', period: 4, dayOfWeek: 3, className: '3/1' },
    { teacher: NGHI, session: 'morning', period: 4, dayOfWeek: 4, className: '4/5' },
    { teacher: NGHI, session: 'morning', period: 4, dayOfWeek: 5, className: '4/1' },
    { teacher: NGHI, session: 'morning', period: 4, dayOfWeek: 6, className: '5/3' },

    // ===== CHIỀU ===== (Thứ 3 và Thứ 6 có 2 lớp song song, 2 giáo viên)
    // Tiết 1 — 13:30-14:05
    { teacher: NGHI, session: 'afternoon', period: 1, dayOfWeek: 3, className: '4/2' },
    { teacher: THU, session: 'afternoon', period: 1, dayOfWeek: 3, className: '5/6' },
    { teacher: THU, session: 'afternoon', period: 1, dayOfWeek: 4, className: '1/3' },
    { teacher: THU, session: 'afternoon', period: 1, dayOfWeek: 5, className: '2/7' },
    { teacher: THU, session: 'afternoon', period: 1, dayOfWeek: 6, className: '3/6' },
    { teacher: NGHI, session: 'afternoon', period: 1, dayOfWeek: 6, className: '1/10' },
    // Tiết 2 — 14:05-14:40
    { teacher: NGHI, session: 'afternoon', period: 2, dayOfWeek: 3, className: '2/1' },
    { teacher: THU, session: 'afternoon', period: 2, dayOfWeek: 3, className: '4/7' },
    { teacher: THU, session: 'afternoon', period: 2, dayOfWeek: 4, className: '1/7' },
    { teacher: THU, session: 'afternoon', period: 2, dayOfWeek: 5, className: '1/9' },
    { teacher: THU, session: 'afternoon', period: 2, dayOfWeek: 6, className: '1/6' },
    { teacher: NGHI, session: 'afternoon', period: 2, dayOfWeek: 6, className: '1/8' },
    // Tiết 3 — 15:00-15:35
    { teacher: NGHI, session: 'afternoon', period: 3, dayOfWeek: 3, className: '4/6' },
    { teacher: THU, session: 'afternoon', period: 3, dayOfWeek: 3, className: '1/4' },
    { teacher: THU, session: 'afternoon', period: 3, dayOfWeek: 4, className: '1/5' },
    { teacher: THU, session: 'afternoon', period: 3, dayOfWeek: 5, className: '5/4' },
    { teacher: THU, session: 'afternoon', period: 3, dayOfWeek: 6, className: '5/1' },
    { teacher: NGHI, session: 'afternoon', period: 3, dayOfWeek: 6, className: '3/7' },
];

/** "3/4" → khối 3. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className.split('/')[0]);
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
        for (const name of [NGHI, THU]) {
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
