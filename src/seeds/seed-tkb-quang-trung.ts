/**
 * Seed TKB KNS/STEM — Trường THCS Quang Trung, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy: chỉ buổi chiều Thứ 2, tiết 3 và tiết 4, hai cột lớp
 * chạy song song — thầy Huy dạy STEM (7A5, 7A2), cô Diểm dạy KNS (8A4, 8A2).
 * Tổng 4 tiết/tuần, mỗi lớp đúng 1 tiết.
 *
 * "Huy" trong bảng là Tăng Quốc Huy (id=26): thầy trống hẳn Thứ 2, còn
 * La Thành Huy (id=150) đã kín đúng hai khung 15:30 và 16:15 Thứ 2 ở
 * THCS Hoàng Văn Thụ nên không thể là người này.
 *
 * Script KHÔNG tạo trường: `schools` phải có sẵn bản ghi trường này (Nhân sự
 * khai trên UI để có địa chỉ/toạ độ/bán kính check-in).
 *
 * Chạy lại được nhiều lần: tra trước theo khoá tự nhiên rồi mới INSERT.
 *
 * Chạy: npm run seed:tkb-quang-trung
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME_LIKE = '%QUANG TRUNG%';
const SCHOOL_YEAR = '2026-2027';

/** Giữ đúng tên môn trường đã dùng ở năm 2025-2026 để không sinh bản trùng. */
const SUBJECTS = {
    KNS: { name: 'Kỹ năng sống', catalogId: 6 },
    STEM: { name: 'STEM', catalogId: 14 },
} as const;

type SubjectKey = keyof typeof SUBJECTS;

/** Chốt theo id vì trong DB có hai giáo viên tên gọi "Huy". */
const TEACHERS = {
    HUY: { id: 26, name: 'Tăng Quốc Huy' },
    DIEM: { id: 9, name: 'Lê Thị Hồng Diểm' },
} as const;

type TeacherKey = keyof typeof TEACHERS;

/** Cùng khoảng hiệu lực với các TKB 2026-2027 khác. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Cột "THỜI GIAN" của bảng — buổi chiều, chỉ dùng tiết 3 và 4. */
const PERIOD_TIME: Record<number, readonly [string, string]> = {
    1: ['13:30', '14:15'],
    2: ['14:15', '15:00'],
    3: ['15:30', '16:15'],
    4: ['16:15', '17:00'],
};

interface Slot {
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    period: number;
    className: string;
    subject: SubjectKey;
    teacher: TeacherKey;
}

const SLOTS: Slot[] = [
    // ===== CHIỀU THỨ 2 =====
    { dayOfWeek: 2, period: 3, className: '7A5', subject: 'STEM', teacher: 'HUY' },
    { dayOfWeek: 2, period: 3, className: '8A4', subject: 'KNS', teacher: 'DIEM' },

    { dayOfWeek: 2, period: 4, className: '7A2', subject: 'STEM', teacher: 'HUY' },
    { dayOfWeek: 2, period: 4, className: '8A2', subject: 'KNS', teacher: 'DIEM' },
];

/** "7A5" → khối 7. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className.split('A')[0]);
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
        const subjectIds = new Map<SubjectKey, number>();
        for (const key of Object.keys(SUBJECTS) as SubjectKey[]) {
            const { name, catalogId } = SUBJECTS[key];
            let subject = await client.query(
                `SELECT id FROM subjects
                 WHERE school_id = $1 AND TRIM(name) = $2 AND school_year = $3
                 ORDER BY id`,
                [schoolId, name, SCHOOL_YEAR],
            );
            if (subject.rowCount === 0) {
                subject = await client.query(
                    `INSERT INTO subjects (name, school_id, school_year, catalog_id)
                     VALUES ($1, $2, $3, $4) RETURNING id`,
                    [name, schoolId, SCHOOL_YEAR, catalogId],
                );
                // `code` sinh từ chính id (quy ước SUB<id> như dữ liệu sẵn có).
                await client.query(`UPDATE subjects SET code = $1 WHERE id = $2`, [
                    `SUB${subject.rows[0].id}`,
                    subject.rows[0].id,
                ]);
                console.log(`+ Môn "${name}" ${SCHOOL_YEAR} (id=${subject.rows[0].id})`);
            } else {
                console.log(`· Môn "${name}" ${SCHOOL_YEAR} đã có (id=${subject.rows[0].id})`);
            }
            subjectIds.set(key, subject.rows[0].id);
        }

        // ===== Lớp học =====
        const classIds = new Map<string, number>();
        for (const slot of SLOTS) {
            if (classIds.has(slot.className)) continue;
            let cls = await client.query(
                `SELECT id FROM school_classes
                 WHERE school_id = $1 AND UPPER(TRIM(name)) = UPPER($2) AND school_year = $3
                   AND school_location_id IS NULL`,
                [schoolId, slot.className, SCHOOL_YEAR],
            );
            if (cls.rowCount === 0) {
                cls = await client.query(
                    `INSERT INTO school_classes (school_id, name, grade_level, school_year)
                     VALUES ($1, $2, $3, $4) RETURNING id`,
                    [schoolId, slot.className, gradeLevelOf(slot.className), SCHOOL_YEAR],
                );
                console.log(`+ Lớp ${slot.className} (id=${cls.rows[0].id})`);
            }
            const classId: number = cls.rows[0].id;
            classIds.set(slot.className, classId);

            await client.query(
                `INSERT INTO school_class_subjects (class_id, subject_id)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [classId, subjectIds.get(slot.subject)!],
            );
        }
        for (const subjectId of subjectIds.values()) {
            await client.query(
                `UPDATE subjects
                 SET class_count = (SELECT count(*) FROM school_class_subjects WHERE subject_id = $1)
                 WHERE id = $1`,
                [subjectId],
            );
        }
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
            const teacherId = TEACHERS[slot.teacher].id;
            const classId = classIds.get(slot.className)!;
            const subjectId = subjectIds.get(slot.subject)!;

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
    console.error('✗ Seed thất bại:', err instanceof Error ? err.message : err);
    process.exit(1);
});
