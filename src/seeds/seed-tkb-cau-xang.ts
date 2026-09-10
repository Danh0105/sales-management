/**
 * Seed TKB Kỹ năng công dân số — TH & THCS Cầu Xáng, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy: một giáo viên duy nhất (Nguyễn Trần Tâm) dạy 20 lớp,
 * mỗi lớp đúng 1 tiết/tuần, rải trên Thứ 2 / Thứ 3 / Thứ 4 / Thứ 6, cả sáng lẫn chiều.
 *
 * Script KHÔNG tạo trường: `schools` phải có sẵn bản ghi trường này (Nhân sự
 * khai trên UI để có địa chỉ/toạ độ/bán kính check-in — thiếu toạ độ thì giáo
 * viên không check-in được, nên không tạo trường rỗng từ script).
 *
 * Chạy lại được nhiều lần: tra trước theo khoá tự nhiên rồi mới INSERT.
 *
 * Chạy: npm run seed:tkb-cau-xang
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

/** Khớp lỏng theo từ khoá vì tên trường trong DB có thể kèm tiền tố "TRƯỜNG". */
const SCHOOL_NAME_LIKE = '%CẦU XÁNG%';
const SCHOOL_YEAR = '2026-2027';
const SUBJECT_NAME = 'CDS';
const SUBJECT_CATALOG_ID = 3;

/** Giáo viên "Tâm" trong bảng TKB — chốt theo id vì có 3 giáo viên trùng tên gọi. */
const TEACHER_ID = 192;
const TEACHER_NAME = 'Nguyễn Trần Tâm';

/** Cùng khoảng hiệu lực với các TKB 2026-2027 khác đang chạy. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

const PERIOD_TIME = {
    morning: {
        1: ['07:30', '08:05'],
        2: ['08:10', '08:45'],
        3: ['09:20', '09:55'],
        4: ['10:00', '10:35'],
    },
    afternoon: {
        1: ['13:30', '14:05'],
        2: ['14:10', '14:45'],
        3: ['15:25', '16:00'],
    },
} as const;

type Session = keyof typeof PERIOD_TIME;

interface Slot {
    session: Session;
    period: number;
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    className: string;
}

const SLOTS: Slot[] = [
    // ===== SÁNG =====
    { session: 'morning', period: 1, dayOfWeek: 4, className: '1A' },
    { session: 'morning', period: 1, dayOfWeek: 6, className: '3D' },

    { session: 'morning', period: 2, dayOfWeek: 4, className: '1C' },
    { session: 'morning', period: 2, dayOfWeek: 6, className: '3B' },

    { session: 'morning', period: 3, dayOfWeek: 4, className: '1D' },
    { session: 'morning', period: 3, dayOfWeek: 6, className: '2A' },

    { session: 'morning', period: 4, dayOfWeek: 4, className: '1B' },
    { session: 'morning', period: 4, dayOfWeek: 6, className: '2B' },

    // ===== CHIỀU =====
    { session: 'afternoon', period: 1, dayOfWeek: 2, className: '2C' },
    { session: 'afternoon', period: 1, dayOfWeek: 3, className: '5C' },
    { session: 'afternoon', period: 1, dayOfWeek: 4, className: '5B' },
    { session: 'afternoon', period: 1, dayOfWeek: 6, className: '4B' },

    { session: 'afternoon', period: 2, dayOfWeek: 2, className: '3C' },
    { session: 'afternoon', period: 2, dayOfWeek: 3, className: '5D' },
    { session: 'afternoon', period: 2, dayOfWeek: 4, className: '5E' },
    { session: 'afternoon', period: 2, dayOfWeek: 6, className: '4A' },

    { session: 'afternoon', period: 3, dayOfWeek: 2, className: '3A' },
    { session: 'afternoon', period: 3, dayOfWeek: 3, className: '2D' },
    { session: 'afternoon', period: 3, dayOfWeek: 4, className: '5A' },
    { session: 'afternoon', period: 3, dayOfWeek: 6, className: '4C' },
];

/** "1A" → khối 1, "5E" → khối 5. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className.replace(/[^0-9]/g, ''));
    return Number.isFinite(grade) && grade > 0 ? grade : null;
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
            const [startTime, endTime] = (PERIOD_TIME[slot.session] as Record<
                number,
                readonly [string, string]
            >)[slot.period];
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
