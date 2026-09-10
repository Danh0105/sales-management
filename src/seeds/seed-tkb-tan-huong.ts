/**
 * Seed TKB KNS/STEM/CDS — Trường Tiểu học Tân Hương, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy: 4 giáo viên (Quế Chi, Kim Yến, Ngọc Hương, Trần thị
 * hằng) dạy 30 tiết/tuần, chỉ buổi chiều, tiết 6 → tiết 8, Thứ 2 → Thứ 6.
 *
 * Tên lớp trong bảng đã kèm môn ("1/5 STEM", "3/4 CDS") và trường đang lưu
 * đúng như vậy từ năm 2025-2026, nên giữ nguyên quy ước đó; môn của mỗi tiết
 * suy ra từ hậu tố tên lớp. Khác với dữ liệu 2025-2026 (mọi tiết bị gán chung
 * môn "KỸ NĂNG SỐNG"), bản này gán đúng 3 môn.
 *
 * Script KHÔNG tạo trường: `schools` phải có sẵn bản ghi (Nhân sự khai trên UI
 * để có toạ độ/bán kính check-in).
 *
 * Chạy lại được nhiều lần: tra trước theo khoá tự nhiên rồi mới INSERT.
 *
 * Chạy: npm run seed:tkb-tan-huong
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME_LIKE = '%TÂN HƯƠNG%';
const SCHOOL_YEAR = '2026-2027';

/** Ba môn của TKB này — giữ đúng tên trường đã dùng ở năm 2025-2026. */
const SUBJECTS = {
    KNS: { name: 'KỸ NĂNG SỐNG', catalogId: 6 },
    STEM: { name: 'STEM', catalogId: 14 },
    CDS: { name: 'CÔNG DÂN SỐ', catalogId: 17 },
} as const;

type SubjectKey = keyof typeof SUBJECTS;

/** Cùng khoảng hiệu lực với các TKB 2026-2027 khác. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Cột "THỜI GIAN" của bảng: chỉ buổi chiều, tiết 6 → 8. */
const PERIOD_TIME: Record<number, readonly [string, string]> = {
    6: ['15:00', '15:35'],
    7: ['15:40', '16:20'],
    8: ['16:20', '17:00'],
};

/** Giáo viên chốt theo id (tên trong DB không đồng nhất hoa/thường). */
const TEACHERS = {
    QUE_CHI: { id: 35, name: 'Bùi Thị Quế Chi' },
    KIM_YEN: { id: 162, name: 'Trần Thị Kim Yến' },
    HUONG: { id: 62, name: 'Lê Thị Ngọc Hương' },
    HANG: { id: 53, name: 'Trần thị hằng' },
} as const;

type TeacherKey = keyof typeof TEACHERS;

interface Slot {
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    period: number;
    /** Tên lớp kèm môn, đúng như bảng TKB. */
    className: string;
    teacher: TeacherKey;
}

const SLOTS: Slot[] = [
    // ===== Tiết 6 (15:00 - 15:35) =====
    { dayOfWeek: 2, period: 6, className: '1/5 STEM', teacher: 'QUE_CHI' },
    { dayOfWeek: 3, period: 6, className: '3/1 KNS', teacher: 'QUE_CHI' },
    { dayOfWeek: 4, period: 6, className: '3/4 KNS', teacher: 'KIM_YEN' },
    { dayOfWeek: 5, period: 6, className: '1/6 STEM', teacher: 'QUE_CHI' },
    { dayOfWeek: 6, period: 6, className: '3/5 KNS', teacher: 'KIM_YEN' },

    // ===== Tiết 7 (15:40 - 16:20) =====
    { dayOfWeek: 2, period: 7, className: '3/2 KNS', teacher: 'KIM_YEN' },
    { dayOfWeek: 3, period: 7, className: '2/5 STEM', teacher: 'QUE_CHI' },
    { dayOfWeek: 3, period: 7, className: '1/4 STEM', teacher: 'KIM_YEN' },
    { dayOfWeek: 4, period: 7, className: '2/6 STEM', teacher: 'QUE_CHI' },
    { dayOfWeek: 4, period: 7, className: '3/3 KNS', teacher: 'KIM_YEN' },
    { dayOfWeek: 5, period: 7, className: '2/4 STEM', teacher: 'QUE_CHI' },
    { dayOfWeek: 5, period: 7, className: '1/3 STEM', teacher: 'KIM_YEN' },
    { dayOfWeek: 6, period: 7, className: '2/3 STEM', teacher: 'QUE_CHI' },
    { dayOfWeek: 6, period: 7, className: '3/6 KNS', teacher: 'KIM_YEN' },

    // ===== Tiết 8 (16:20 - 17:00) =====
    { dayOfWeek: 2, period: 8, className: '2/2 STEM', teacher: 'QUE_CHI' },
    { dayOfWeek: 2, period: 8, className: '3/4 CDS', teacher: 'KIM_YEN' },
    { dayOfWeek: 2, period: 8, className: '2/4 CDS', teacher: 'HUONG' },
    { dayOfWeek: 2, period: 8, className: '2/6 CDS', teacher: 'HANG' },

    { dayOfWeek: 3, period: 8, className: '2/1 STEM', teacher: 'QUE_CHI' },
    { dayOfWeek: 3, period: 8, className: '3/5 CDS', teacher: 'KIM_YEN' },
    { dayOfWeek: 3, period: 8, className: '2/5 CDS', teacher: 'HUONG' },
    { dayOfWeek: 3, period: 8, className: '2/3 CDS', teacher: 'HANG' },

    { dayOfWeek: 4, period: 8, className: '3/6 CDS', teacher: 'QUE_CHI' },
    { dayOfWeek: 4, period: 8, className: '3/1 CDS', teacher: 'KIM_YEN' },
    { dayOfWeek: 4, period: 8, className: '1/1 STEM', teacher: 'HUONG' },
    { dayOfWeek: 4, period: 8, className: '2/2 CDS', teacher: 'HANG' },

    { dayOfWeek: 5, period: 8, className: '1/2 STEM', teacher: 'QUE_CHI' },
    { dayOfWeek: 5, period: 8, className: '3/2 CDS', teacher: 'KIM_YEN' },

    { dayOfWeek: 6, period: 8, className: '2/1 CDS', teacher: 'QUE_CHI' },
    { dayOfWeek: 6, period: 8, className: '3/3 CDS', teacher: 'KIM_YEN' },
];

/** "3/4 CDS" → khối 3. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className.split('/')[0]);
    return Number.isFinite(grade) ? grade : null;
}

/** "3/4 CDS" → CDS. Hậu tố tên lớp chính là môn trong bảng TKB. */
function subjectKeyOf(className: string): SubjectKey {
    const suffix = className.split(' ').pop() as SubjectKey;
    if (!(suffix in SUBJECTS)) {
        throw new Error(`Không suy ra được môn từ tên lớp "${className}"`);
    }
    return suffix;
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

        // ===== Lớp học ===== (tên lớp đã kèm môn nên mỗi lớp gắn đúng 1 môn)
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
                [classId, subjectIds.get(subjectKeyOf(name))!],
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
            const subjectId = subjectIds.get(subjectKeyOf(slot.className))!;

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
