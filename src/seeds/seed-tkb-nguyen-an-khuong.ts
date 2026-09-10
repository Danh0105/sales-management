/**
 * Seed TKB Kỹ năng sống — THCS Nguyễn An Khương, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy của trường: 2 giáo viên (Đào Đông Nhi dạy sáng Thứ 4,
 * Trần Cao Cường dạy chiều Thứ 3–Thứ 6), mỗi ô là 1 tiết cho 1 lớp.
 *
 * Script tạo đủ 3 tầng dữ liệu còn thiếu của trường trong năm học này:
 * môn học → lớp học → mẫu lịch (`teaching_schedules`).
 *
 * Chạy lại được nhiều lần: mọi INSERT đều tra trước theo khoá tự nhiên
 * (môn theo school+name+year, lớp theo school+name+year, lịch theo
 * teacher+class+subject+day+start_time) nên không sinh bản ghi trùng.
 *
 * Chạy: npm run seed:tkb-nguyen-an-khuong
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME = 'TRUNG HỌC CƠ SỞ NGUYỄN AN KHƯƠNG';
const SCHOOL_YEAR = '2026-2027';
const SUBJECT_NAME = 'Kỹ năng sống';
/** Môn trong danh mục dùng chung — lấy theo môn KNS năm trước của chính trường này. */
const SUBJECT_CATALOG_ID = 6;

/** Khớp với khoảng hiệu lực đang dùng cho phần lớn lịch năm 2026-2027. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Khung giờ từng tiết theo buổi, đúng cột "THỜI GIAN" của bảng TKB. */
const PERIOD_TIME = {
    morning: {
        1: ['07:30', '08:15'],
        2: ['08:15', '09:00'],
        3: ['09:25', '10:15'],
        4: ['10:15', '11:00'],
    },
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

const NHI = 'Đào Đông Nhi';
const CUONG = 'Trần Cao Cường';

const SLOTS: Slot[] = [
    // ===== SÁNG — Đào Đông Nhi, chỉ Thứ 4 =====
    { teacher: NHI, session: 'morning', period: 1, dayOfWeek: 4, className: '6A1' },
    { teacher: NHI, session: 'morning', period: 2, dayOfWeek: 4, className: '7TH2' },
    { teacher: NHI, session: 'morning', period: 3, dayOfWeek: 4, className: '6A2' },
    { teacher: NHI, session: 'morning', period: 4, dayOfWeek: 4, className: '7A4' },

    // ===== CHIỀU — Trần Cao Cường, Thứ 3 =====
    { teacher: CUONG, session: 'afternoon', period: 1, dayOfWeek: 3, className: '6A5' },
    { teacher: CUONG, session: 'afternoon', period: 2, dayOfWeek: 3, className: '7A3' },
    { teacher: CUONG, session: 'afternoon', period: 3, dayOfWeek: 3, className: '7A5' },
    { teacher: CUONG, session: 'afternoon', period: 4, dayOfWeek: 3, className: '6A6' },

    // ===== CHIỀU — Trần Cao Cường, Thứ 4 (tiết 4 trống) =====
    { teacher: CUONG, session: 'afternoon', period: 1, dayOfWeek: 4, className: '6A3' },
    { teacher: CUONG, session: 'afternoon', period: 2, dayOfWeek: 4, className: '7TH1' },
    { teacher: CUONG, session: 'afternoon', period: 3, dayOfWeek: 4, className: '7A7' },

    // ===== CHIỀU — Trần Cao Cường, Thứ 5 =====
    { teacher: CUONG, session: 'afternoon', period: 1, dayOfWeek: 5, className: '7A2' },
    { teacher: CUONG, session: 'afternoon', period: 2, dayOfWeek: 5, className: '7A1' },
    { teacher: CUONG, session: 'afternoon', period: 3, dayOfWeek: 5, className: '6A7' },
    { teacher: CUONG, session: 'afternoon', period: 4, dayOfWeek: 5, className: '6TH2' },

    // ===== CHIỀU — Trần Cao Cường, Thứ 6 =====
    { teacher: CUONG, session: 'afternoon', period: 1, dayOfWeek: 6, className: '6TH1' },
    { teacher: CUONG, session: 'afternoon', period: 2, dayOfWeek: 6, className: '6A8' },
    { teacher: CUONG, session: 'afternoon', period: 3, dayOfWeek: 6, className: '6A4' },
    { teacher: CUONG, session: 'afternoon', period: 4, dayOfWeek: 6, className: '7A6' },
];

/** "6A1" / "7TH2" → khối 6 hoặc 7. */
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
        const school = await client.query(
            `SELECT id FROM schools WHERE name = $1`,
            [SCHOOL_NAME],
        );
        if (school.rowCount === 0) {
            throw new Error(`Không tìm thấy trường "${SCHOOL_NAME}"`);
        }
        const schoolId: number = school.rows[0].id;
        console.log(`✓ Trường "${SCHOOL_NAME}" (id=${schoolId})`);

        // ===== Giáo viên =====
        const teacherIds = new Map<string, number>();
        for (const name of [NHI, CUONG]) {
            const found = await client.query(
                `SELECT id FROM teachers WHERE name = $1`,
                [name],
            );
            if (found.rowCount === 0) {
                throw new Error(`Không tìm thấy giáo viên "${name}"`);
            }
            if (found.rowCount > 1) {
                throw new Error(`Có ${found.rowCount} giáo viên trùng tên "${name}"`);
            }
            teacherIds.set(name, found.rows[0].id);
            console.log(`✓ Giáo viên "${name}" (id=${found.rows[0].id})`);
        }

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

            // Môn được tổ chức dạy tại lớp này.
            await client.query(
                `INSERT INTO school_class_subjects (class_id, subject_id)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [classId, subjectId],
            );
        }
        await client.query(
            `UPDATE subjects SET class_count = $1 WHERE id = $2`,
            [classNames.length, subjectId],
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
