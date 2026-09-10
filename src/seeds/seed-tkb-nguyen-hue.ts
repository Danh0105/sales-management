/**
 * Seed TKB KNS/STEM — Trường THCS Nguyễn Huệ, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy: chỉ buổi chiều, tiết 1 → tiết 4. Hai giáo viên dạy
 * song song ở Thứ 2 và Thứ 3 (bảng có 2 cột Lớp/GV cho mỗi ngày đó):
 *   - Lê Thị Thanh Tâm  → Kỹ năng sống
 *   - Bùi Đặng Bảo Toàn → STEM
 * Thứ 4 chỉ còn 2 tiết STEM của thầy Toàn; Thứ 5 và Thứ 6 trống.
 *
 * Một số ô là lớp ghép ("8A2+8A4", "7A3+8A3+8A1") — trường đang lưu nguyên
 * chuỗi ghép làm tên lớp nên giữ đúng quy ước đó.
 *
 * Dữ liệu 2026-2027 đã nhập trước đó gán nhầm 6 tiết của cô Tâm vào môn STEM
 * và để hiệu lực 01/09–30/09; script sẽ sửa lại đúng môn/khoảng hiệu lực thay
 * vì chèn thêm bản ghi trùng.
 *
 * Script KHÔNG tạo trường: `schools` phải có sẵn bản ghi.
 * Chạy lại được nhiều lần.
 *
 * Chạy: npm run seed:tkb-nguyen-hue
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME_LIKE = '%NGUYỄN HUỆ%';
const SCHOOL_YEAR = '2026-2027';

/** Giữ đúng tên môn trường đã dùng từ năm 2025-2026. */
const SUBJECTS = {
    KNS: { name: 'Kỹ năng sống', catalogId: 6 },
    STEM: { name: 'STEM', catalogId: 14 },
} as const;

type SubjectKey = keyof typeof SUBJECTS;

/** Cùng khoảng hiệu lực với các TKB 2026-2027 khác. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Cột "THỜI GIAN" của bảng: chỉ buổi chiều, tiết 1 → 4. */
const PERIOD_TIME: Record<number, readonly [string, string]> = {
    1: ['13:30', '14:15'],
    2: ['14:15', '15:00'],
    3: ['15:30', '16:15'],
    4: ['16:15', '17:00'],
};

/** Giáo viên chốt theo id (có nhiều người trùng tên gọi "Tâm"). */
const TEACHERS = {
    TAM: { id: 21, name: 'Lê Thị Thanh Tâm' },
    TOAN: { id: 118, name: 'Bùi Đặng Bảo Toàn' },
} as const;

type TeacherKey = keyof typeof TEACHERS;

interface Slot {
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    period: number;
    className: string;
    teacher: TeacherKey;
    subject: SubjectKey;
}

const SLOTS: Slot[] = [
    // ===== THỨ 2 =====
    { dayOfWeek: 2, period: 1, className: '7A2', teacher: 'TOAN', subject: 'STEM' },
    { dayOfWeek: 2, period: 2, className: '8A5', teacher: 'TAM', subject: 'KNS' },
    { dayOfWeek: 2, period: 3, className: '8A2+8A4', teacher: 'TAM', subject: 'KNS' },
    { dayOfWeek: 2, period: 3, className: '7A1', teacher: 'TOAN', subject: 'STEM' },
    { dayOfWeek: 2, period: 4, className: '7A3+8A3+8A1', teacher: 'TAM', subject: 'KNS' },
    { dayOfWeek: 2, period: 4, className: '8A2', teacher: 'TOAN', subject: 'STEM' },

    // ===== THỨ 3 =====
    { dayOfWeek: 3, period: 1, className: '7A3', teacher: 'TOAN', subject: 'STEM' },
    { dayOfWeek: 3, period: 2, className: '7A2', teacher: 'TAM', subject: 'KNS' },
    { dayOfWeek: 3, period: 2, className: '7A4', teacher: 'TOAN', subject: 'STEM' },
    { dayOfWeek: 3, period: 3, className: '8A6', teacher: 'TAM', subject: 'KNS' },
    { dayOfWeek: 3, period: 3, className: '8A4', teacher: 'TOAN', subject: 'STEM' },
    // Bảng ghi "7a4+7a1"; trường đã lưu lớp ghép này với tên "7A1+7A4".
    { dayOfWeek: 3, period: 4, className: '7A1+7A4', teacher: 'TAM', subject: 'KNS' },
    { dayOfWeek: 3, period: 4, className: '8A1+8A3', teacher: 'TOAN', subject: 'STEM' },

    // ===== THỨ 4 ===== (Thứ 5, Thứ 6 trống)
    { dayOfWeek: 4, period: 2, className: '8A6', teacher: 'TOAN', subject: 'STEM' },
    { dayOfWeek: 4, period: 3, className: '8A5', teacher: 'TOAN', subject: 'STEM' },
];

/** `date` từ pg về dạng Date (giờ địa phương) — đưa về "YYYY-MM-DD" để so sánh. */
function isoDate(value: Date | string | null): string | null {
    if (value === null) return null;
    if (typeof value === 'string') return value.slice(0, 10);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
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

        // ===== Lớp học ===== (lớp ghép giữ nguyên chuỗi "8A2+8A4" làm tên)
        const classIds = new Map<string, number>();
        for (const name of [...new Set(SLOTS.map((s) => s.className))]) {
            let cls = await client.query(
                `SELECT id FROM school_classes
                 WHERE school_id = $1 AND UPPER(TRIM(name)) = UPPER($2) AND school_year = $3
                   AND school_location_id IS NULL`,
                [schoolId, name, SCHOOL_YEAR],
            );
            if (cls.rowCount === 0) {
                cls = await client.query(
                    `INSERT INTO school_classes (school_id, name, school_year)
                     VALUES ($1, $2, $3) RETURNING id`,
                    [schoolId, name, SCHOOL_YEAR],
                );
                console.log(`+ Lớp ${name} (id=${cls.rows[0].id})`);
            }
            classIds.set(name, cls.rows[0].id);
        }

        // Mỗi lớp gắn đúng những môn nó thực học trong TKB.
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
        let updated = 0;
        let skipped = 0;
        for (const slot of SLOTS) {
            const [startTime, endTime] = PERIOD_TIME[slot.period];
            const teacherId = TEACHERS[slot.teacher].id;
            const classId = classIds.get(slot.className)!;
            const subjectId = subjectIds.get(slot.subject)!;
            const note = `TKB ${SCHOOL_YEAR} — tiết ${slot.period} chiều`;

            // Khớp theo giáo viên/lớp/ngày/giờ (KHÔNG theo môn): bản nhập cũ
            // gán nhầm môn nên phải sửa tại chỗ thay vì chèn thêm.
            const existing = await client.query(
                `SELECT id, subject_id, end_time, effective_from, effective_to, is_active
                 FROM teaching_schedules
                 WHERE teacher_id = $1 AND class_id = $2 AND school_id = $3
                   AND day_of_week = $4 AND start_time = $5`,
                [teacherId, classId, schoolId, slot.dayOfWeek, startTime],
            );
            if (existing.rowCount! > 1) {
                throw new Error(
                    `Có ${existing.rowCount} mẫu lịch trùng cho ${slot.className} thứ ${slot.dayOfWeek} ${startTime} — cần dọn tay trước.`,
                );
            }
            if (existing.rowCount === 1) {
                const row = existing.rows[0];
                const needsFix =
                    row.subject_id !== subjectId ||
                    isoDate(row.effective_from) !== EFFECTIVE_FROM ||
                    isoDate(row.effective_to) !== EFFECTIVE_TO ||
                    !row.is_active;
                if (!needsFix) {
                    skipped++;
                    continue;
                }
                await client.query(
                    `UPDATE teaching_schedules
                     SET subject_id = $1, end_time = $2, effective_from = $3,
                         effective_to = $4, is_active = true, note = $5
                     WHERE id = $6`,
                    [subjectId, endTime, EFFECTIVE_FROM, EFFECTIVE_TO, note, row.id],
                );
                console.log(
                    `~ Sửa lịch id=${row.id} (${slot.className}, thứ ${slot.dayOfWeek}, tiết ${slot.period}) → môn ${SUBJECTS[slot.subject].name}`,
                );
                updated++;
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
                    note,
                ],
            );
            created++;
        }

        await client.query('COMMIT');
        console.log(
            `✓ Xong: ${created} mẫu lịch mới, ${updated} đã sửa, ${skipped} đã đúng (tổng ${SLOTS.length} tiết/tuần).`,
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
