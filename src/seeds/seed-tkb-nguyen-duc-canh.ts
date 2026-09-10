/**
 * Seed TKB KNS — Trường THCS Nguyễn Đức Cảnh, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy của trường. Bảng có 3 cột lớp song song ở THỨ 2 (KNS)
 * — 3 giáo viên dạy cùng khung giờ — nhưng hiện chỉ 2 cột ghi tên GV:
 * cô Quỳnh Như và cô Thái Thanh. Cột thứ ba (7A2/7A6/7A4/7A3) và các tiết
 * THỨ 5 (STEM/KNS) trong bảng chưa ghi giáo viên nên CHƯA seed — bổ sung sau
 * khi trường chốt phân công.
 *
 * Script KHÔNG tạo trường: `schools` phải có sẵn bản ghi (id=449).
 *
 * Chạy lại được nhiều lần: tra trước theo khoá tự nhiên rồi mới INSERT.
 *
 * Chạy: npm run seed:tkb-nguyen-duc-canh
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME_LIKE = '%ĐỨC CẢNH%';
const SCHOOL_YEAR = '2026-2027';

/** Giữ đúng tên môn trường đã dùng ở năm 2025-2026 (subject id=528). */
const SUBJECT_NAME = 'Kỹ năng sống';
const SUBJECT_CATALOG_ID = 6;

/** Cùng khoảng hiệu lực với các TKB 2026-2027 khác. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Cột "THỜI GIAN" của bảng — buổi chiều, tiết 1 → 4. */
const PERIOD_TIME: Record<number, readonly [string, string]> = {
    1: ['13:30', '14:15'],
    2: ['14:15', '15:00'],
    3: ['15:30', '16:15'],
    4: ['16:15', '17:00'],
};

const NHU = 'Lê Thị Quỳnh Như';
const THANH = 'Nguyễn Thái Thanh';

interface Slot {
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    period: number;
    className: string;
    teacher: string;
}

/** Toàn bộ tiết đã ghi rõ GV đều nằm ở chiều THỨ 2. */
const SLOTS: Slot[] = [
    // ===== Cột cô Như =====
    { dayOfWeek: 2, period: 2, className: '8A4', teacher: NHU },
    { dayOfWeek: 2, period: 3, className: '8A6', teacher: NHU },
    { dayOfWeek: 2, period: 4, className: '8A3', teacher: NHU },

    // ===== Cột cô Thanh =====
    { dayOfWeek: 2, period: 1, className: '8A2', teacher: THANH },
    { dayOfWeek: 2, period: 2, className: '6A2', teacher: THANH },
    { dayOfWeek: 2, period: 3, className: '6A1', teacher: THANH },
];

/** "8A4" → khối 8. */
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
            `SELECT id, name FROM schools WHERE name ILIKE $1`,
            [SCHOOL_NAME_LIKE],
        );
        if (school.rowCount === 0) {
            throw new Error(`Không tìm thấy trường khớp "${SCHOOL_NAME_LIKE}"`);
        }
        if (school.rowCount! > 1) {
            throw new Error(`Có ${school.rowCount} trường khớp "${SCHOOL_NAME_LIKE}"`);
        }
        const schoolId: number = school.rows[0].id;
        console.log(`✓ Trường "${school.rows[0].name}" (id=${schoolId})`);

        // ===== Giáo viên =====
        const teacherIds = new Map<string, number>();
        for (const name of [...new Set(SLOTS.map((s) => s.teacher))]) {
            const found = await client.query(
                `SELECT id FROM teachers WHERE TRIM(name) = $1`,
                [name],
            );
            if (found.rowCount === 0) {
                throw new Error(`Không tìm thấy giáo viên "${name}"`);
            }
            if (found.rowCount! > 1) {
                throw new Error(`Có ${found.rowCount} giáo viên trùng tên "${name}"`);
            }
            teacherIds.set(name, found.rows[0].id);
            console.log(`✓ Giáo viên "${name}" (id=${found.rows[0].id})`);
        }

        // ===== Môn học ===== (TRIM: dữ liệu 2025-2026 có tên môn dư khoảng trắng)
        let subject = await client.query(
            `SELECT id FROM subjects
             WHERE school_id = $1 AND TRIM(LOWER(name)) = LOWER($2) AND school_year = $3
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
        const classIds = new Map<string, number>();
        for (const name of [...new Set(SLOTS.map((s) => s.className))]) {
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
            const [startTime, endTime] = PERIOD_TIME[slot.period];
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
