/**
 * Seed TKB KNS/STEM — THCS Lạc Hồng (Phân hiệu), năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy của phân hiệu: 14 tiết/tuần, một giáo viên duy nhất —
 * thầy Bùi Bảo Tín (bảng chỉ ghi "Bảo Tín"). Bảng chia môn theo NGÀY:
 *   - Thứ 4, Thứ 5 → STEM (10 tiết)
 *   - Thứ 6        → Kỹ năng sống (4 tiết)
 *   - Thứ 2, Thứ 3 → trống
 *
 * Phân hiệu là cơ sở thứ 3 của trường (school_locations.name = 'Phân hiệu',
 * 289 CMT8, phường Hoà Hưng); CS1/CS2 là hai cơ sở còn lại, có TKB riêng trong
 * seed-tkb-lac-hong.ts. Tên lớp trong DB chỉ giữ phần "7/10", cơ sở nằm ở
 * school_classes.school_location_id — đúng quy ước của trường này.
 *
 * Chạy lại được nhiều lần: mọi INSERT đều tra trước theo khoá tự nhiên nên
 * không sinh bản ghi trùng.
 *
 * Chạy: npm run seed:tkb-lac-hong-phan-hieu
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME = 'THCS Lạc Hồng';
const SCHOOL_YEAR = '2026-2027';
const CAMPUS_NAME = 'Phân hiệu';

/** Hai môn của bảng này, kèm id trong danh mục dùng chung (subject_catalogs). */
const SUBJECTS = {
    STEM: { name: 'STEM', catalogId: 14 },
    KNS: { name: 'Kỹ năng sống', catalogId: 6 },
} as const;
type SubjectKey = keyof typeof SUBJECTS;

const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Khung giờ từng tiết, đúng cột "THỜI GIAN" của bảng TKB. */
const PERIOD_TIME = {
    'S1': ['07:15', '08:00'],
    'S2': ['08:00', '08:45'],
    'S3': ['09:15', '10:00'],
    'S4': ['10:00', '10:45'],
    'S5': ['10:45', '11:30'],
    'C1': ['13:45', '14:30'],
    'C2': ['14:30', '15:15'],
    'C3': ['15:45', '16:30'],
    'C4': ['16:30', '17:15'],
} as const;

type Period = keyof typeof PERIOD_TIME;

interface Slot {
    teacher: string;
    period: Period;
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    className: string;
    subject: SubjectKey;
}

const TIN = 'Bùi Bảo Tín';

const SLOTS: Slot[] = [
    // ===== THỨ 4 (STEM) =====
    { teacher: TIN, dayOfWeek: 4, period: 'S2', className: '8/10', subject: 'STEM' },
    { teacher: TIN, dayOfWeek: 4, period: 'S3', className: '7/9', subject: 'STEM' },
    { teacher: TIN, dayOfWeek: 4, period: 'C1', className: '6/9', subject: 'STEM' },
    { teacher: TIN, dayOfWeek: 4, period: 'C3', className: '8/11', subject: 'STEM' },

    // ===== THỨ 5 (STEM) =====
    { teacher: TIN, dayOfWeek: 5, period: 'S1', className: '6/8', subject: 'STEM' },
    { teacher: TIN, dayOfWeek: 5, period: 'S2', className: '8/9', subject: 'STEM' },
    { teacher: TIN, dayOfWeek: 5, period: 'S3', className: '7/10', subject: 'STEM' },
    { teacher: TIN, dayOfWeek: 5, period: 'C1', className: '7/8', subject: 'STEM' },
    { teacher: TIN, dayOfWeek: 5, period: 'C2', className: '6/7', subject: 'STEM' },
    { teacher: TIN, dayOfWeek: 5, period: 'C3', className: '7/11', subject: 'STEM' },

    // ===== THỨ 6 (KNS) =====
    { teacher: TIN, dayOfWeek: 6, period: 'S3', className: '7/10', subject: 'KNS' },
    { teacher: TIN, dayOfWeek: 6, period: 'C1', className: '7/11', subject: 'KNS' },
    { teacher: TIN, dayOfWeek: 6, period: 'C2', className: '7/9', subject: 'KNS' },
    { teacher: TIN, dayOfWeek: 6, period: 'C3', className: '7/8', subject: 'KNS' },
];

/** "7/10" → khối 7. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className.split('/')[0]);
    return Number.isFinite(grade) ? grade : null;
}

/** Một giáo viên không thể đứng 2 lớp cùng một khung giờ. */
function assertNoTeacherClash() {
    const seen = new Map<string, Slot>();
    for (const slot of SLOTS) {
        const key = `${slot.teacher}|${slot.dayOfWeek}|${slot.period}`;
        const prev = seen.get(key);
        if (prev) {
            throw new Error(
                `Trùng lịch: ${slot.teacher} dạy cả ${prev.className} lẫn ${slot.className} ` +
                    `vào thứ ${slot.dayOfWeek} tiết ${slot.period}`,
            );
        }
        seen.set(key, slot);
    }
}

async function main() {
    assertNoTeacherClash();

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
        if (school.rowCount! > 1) {
            throw new Error(`Có ${school.rowCount} trường trùng tên "${SCHOOL_NAME}"`);
        }
        const schoolId: number = school.rows[0].id;
        console.log(`✓ Trường "${SCHOOL_NAME}" (id=${schoolId})`);

        // ===== Cơ sở ===== (toạ độ check-in của phân hiệu phải khai sẵn trên UI)
        const campus = await client.query(
            `SELECT id FROM school_locations WHERE school_id = $1 AND name = $2`,
            [schoolId, CAMPUS_NAME],
        );
        if (campus.rowCount === 0) {
            throw new Error(
                `Chưa có cơ sở "${CAMPUS_NAME}" của trường id=${schoolId} trong school_locations.`,
            );
        }
        const locationId: number = campus.rows[0].id;
        console.log(`✓ Cơ sở ${CAMPUS_NAME} (id=${locationId})`);

        // ===== Giáo viên =====
        const teacher = await client.query(`SELECT id FROM teachers WHERE name = $1`, [TIN]);
        if (teacher.rowCount === 0) {
            throw new Error(`Không tìm thấy giáo viên "${TIN}"`);
        }
        if (teacher.rowCount! > 1) {
            throw new Error(`Có ${teacher.rowCount} giáo viên trùng tên "${TIN}"`);
        }
        const teacherId: number = teacher.rows[0].id;
        console.log(`✓ Giáo viên "${TIN}" (id=${teacherId})`);

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
        for (const className of new Set(SLOTS.map((s) => s.className))) {
            let cls = await client.query(
                `SELECT id, school_location_id FROM school_classes
                 WHERE school_id = $1 AND UPPER(name) = $2 AND school_year = $3`,
                [schoolId, className, SCHOOL_YEAR],
            );
            if (cls.rowCount === 0) {
                cls = await client.query(
                    `INSERT INTO school_classes
                       (school_id, name, grade_level, school_year, school_location_id)
                     VALUES ($1, $2, $3, $4, $5) RETURNING id, school_location_id`,
                    [schoolId, className, gradeLevelOf(className), SCHOOL_YEAR, locationId],
                );
                console.log(`+ Lớp ${className} (${CAMPUS_NAME}, id=${cls.rows[0].id})`);
            } else if (cls.rows[0].school_location_id !== locationId) {
                // Bản ghi cũ có thể được tạo thiếu/sai cơ sở — sửa lại theo bảng TKB.
                await client.query(
                    `UPDATE school_classes SET school_location_id = $1, updated_at = now()
                     WHERE id = $2`,
                    [locationId, cls.rows[0].id],
                );
                console.log(`~ Lớp ${className}: cơ sở → ${CAMPUS_NAME} (${locationId})`);
            }
            classIds.set(className, cls.rows[0].id);
        }

        // Lớp nào học môn nào — theo đúng các tiết trong bảng.
        for (const slot of SLOTS) {
            await client.query(
                `INSERT INTO school_class_subjects (class_id, subject_id)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [classIds.get(slot.className)!, subjectIds.get(slot.subject)!],
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

            const buoi = slot.period.startsWith('S') ? 'sáng' : 'chiều';
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
                    `TKB ${SCHOOL_YEAR} — tiết ${slot.period.slice(1)} ${buoi}, ${CAMPUS_NAME}`,
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
