/**
 * Seed TKB STEM/AI — Trường THCS An Phú, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy: một giáo viên duy nhất (Hoàng Tuấn Nhật) dạy 21 tiết/tuần,
 * mỗi lớp đúng 1 tiết. Sáng chỉ có Thứ 5 (tiết 1, 2) và Thứ 6 (tiết 1 → 4);
 * chiều đủ Thứ 2 → Thứ 6, mỗi ngày 3 tiết (1, 2, 3) — tiết 4 chiều bỏ trống.
 *
 * Tên lớp giữ nguyên như trong bảng, kèm hậu tố môn ("9C AI", "9C STEM") vì
 * dữ liệu sẵn có của trường đã đặt tên như vậy — cùng một lớp thật nhưng tách
 * đôi theo môn.
 *
 * Trước khi có script này, 21 mẫu lịch đã được nhập tay và lệch hai chỗ so với
 * bảng giấy: giờ 4 tiết sáng (07:15/08:00/09:15/10:00) và toàn bộ lớp STEM bị
 * gán môn "Ai". Script lấy bảng giấy làm chuẩn: tra theo (giáo viên, lớp, thứ)
 * rồi UPDATE giờ/môn cho khớp, không tạo bản trùng.
 *
 * Script KHÔNG tạo trường: `schools` phải có sẵn bản ghi trường này (Nhân sự
 * khai trên UI để có địa chỉ/toạ độ/bán kính check-in).
 *
 * Chạy lại được nhiều lần.
 *
 * Chạy: npm run seed:tkb-an-phu
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME_LIKE = '%AN PHÚ%';
const SCHOOL_YEAR = '2026-2027';

/** Giữ đúng tên môn trường đã dùng ("Ai", không phải "AI") để không sinh bản trùng. */
const SUBJECTS = {
    AI: { name: 'Ai', catalogId: 9 },
    STEM: { name: 'STEM', catalogId: 14 },
} as const;

type SubjectKey = keyof typeof SUBJECTS;

const TEACHER_ID = 79;
const TEACHER_NAME = 'Hoàng Tuấn Nhật';

/** Cùng khoảng hiệu lực với các TKB 2026-2027 khác. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

type Session = 'SANG' | 'CHIEU';

/** Cột "THỜI GIAN" của bảng — tiết đánh số lại từ 1 ở mỗi buổi. */
const PERIOD_TIME: Record<Session, Record<number, readonly [string, string]>> = {
    SANG: {
        1: ['07:30', '08:15'],
        2: ['08:15', '09:00'],
        3: ['09:30', '10:15'],
        4: ['10:15', '11:00'],
    },
    CHIEU: {
        1: ['13:30', '14:15'],
        2: ['14:15', '15:00'],
        3: ['15:30', '16:00'],
        4: ['16:00', '16:45'],
    },
};

interface Slot {
    session: Session;
    period: number;
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    className: string;
    subject: SubjectKey;
}

const SLOTS: Slot[] = [
    // ===== SÁNG =====
    { session: 'SANG', period: 1, dayOfWeek: 5, className: '6ATK AI', subject: 'AI' },
    { session: 'SANG', period: 1, dayOfWeek: 6, className: '7B AI', subject: 'AI' },

    { session: 'SANG', period: 2, dayOfWeek: 5, className: '7A1 AI', subject: 'AI' },
    { session: 'SANG', period: 2, dayOfWeek: 6, className: '7A2 AI', subject: 'AI' },

    { session: 'SANG', period: 3, dayOfWeek: 6, className: '7A3 AI', subject: 'AI' },

    { session: 'SANG', period: 4, dayOfWeek: 6, className: '6B AI', subject: 'AI' },

    // ===== CHIỀU =====
    { session: 'CHIEU', period: 1, dayOfWeek: 2, className: '9C AI', subject: 'AI' },
    { session: 'CHIEU', period: 1, dayOfWeek: 3, className: '6A4 AI', subject: 'AI' },
    { session: 'CHIEU', period: 1, dayOfWeek: 4, className: '9B STEM', subject: 'STEM' },
    { session: 'CHIEU', period: 1, dayOfWeek: 5, className: '7A4 AI', subject: 'AI' },
    { session: 'CHIEU', period: 1, dayOfWeek: 6, className: '6B STEM', subject: 'STEM' },

    { session: 'CHIEU', period: 2, dayOfWeek: 2, className: '8B AI', subject: 'AI' },
    { session: 'CHIEU', period: 2, dayOfWeek: 3, className: '9B AI', subject: 'AI' },
    { session: 'CHIEU', period: 2, dayOfWeek: 4, className: '7B STEM', subject: 'STEM' },
    { session: 'CHIEU', period: 2, dayOfWeek: 5, className: '6A3 AI', subject: 'AI' },
    { session: 'CHIEU', period: 2, dayOfWeek: 6, className: '9C STEM', subject: 'STEM' },

    { session: 'CHIEU', period: 3, dayOfWeek: 2, className: '7ATK2 AI', subject: 'AI' },
    { session: 'CHIEU', period: 3, dayOfWeek: 3, className: '8B STEM', subject: 'STEM' },
    { session: 'CHIEU', period: 3, dayOfWeek: 4, className: '6A2 AI', subject: 'AI' },
    { session: 'CHIEU', period: 3, dayOfWeek: 5, className: '6A1 AI', subject: 'AI' },
    { session: 'CHIEU', period: 3, dayOfWeek: 6, className: '7ATK1 AI', subject: 'AI' },
];

/** "7ATK2 AI" → khối 7, "6B STEM" → khối 6. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className[0]);
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
        // Khoá tra là (giáo viên, lớp, thứ): mỗi lớp chỉ học đúng 1 tiết/tuần nên
        // khoá này đủ phân biệt, và cho phép sửa giờ/môn của bản ghi nhập tay
        // trước đây thay vì chèn thêm bản trùng.
        let created = 0;
        let updated = 0;
        let unchanged = 0;
        for (const slot of SLOTS) {
            const [startTime, endTime] = PERIOD_TIME[slot.session][slot.period];
            const classId = classIds.get(slot.className)!;
            const subjectId = subjectIds.get(slot.subject)!;
            const note = `TKB ${SCHOOL_YEAR} — tiết ${slot.period} ${slot.session === 'SANG' ? 'sáng' : 'chiều'}`;

            const existing = await client.query(
                `SELECT id, subject_id, start_time, end_time FROM teaching_schedules
                 WHERE teacher_id = $1 AND class_id = $2 AND day_of_week = $3`,
                [TEACHER_ID, classId, slot.dayOfWeek],
            );
            if (existing.rowCount! > 1) {
                throw new Error(
                    `Lớp ${slot.className} thứ ${slot.dayOfWeek} có ${existing.rowCount} mẫu lịch — cần dọn tay trước.`,
                );
            }
            if (existing.rowCount === 1) {
                const row = existing.rows[0];
                const same =
                    row.subject_id === subjectId &&
                    String(row.start_time).slice(0, 5) === startTime &&
                    String(row.end_time).slice(0, 5) === endTime;
                if (same) {
                    unchanged++;
                    continue;
                }
                await client.query(
                    `UPDATE teaching_schedules
                     SET subject_id = $1, start_time = $2, end_time = $3, note = $4
                     WHERE id = $5`,
                    [subjectId, startTime, endTime, note, row.id],
                );
                console.log(
                    `~ ${slot.className} thứ ${slot.dayOfWeek}: ${String(row.start_time).slice(0, 5)}→${startTime}, môn ${row.subject_id}→${subjectId}`,
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
                    TEACHER_ID,
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
            `✓ Xong: ${created} mẫu lịch mới, ${updated} sửa lại, ${unchanged} đã khớp (tổng ${SLOTS.length} tiết/tuần).`,
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
