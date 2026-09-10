/**
 * Seed TKB Kỹ năng công dân số — TH & THCS Trịnh Thị Dối, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy: 19 lớp, mỗi lớp đúng 1 tiết/tuần, rải trên
 * Thứ 2 / Thứ 4 / Thứ 5, cả sáng lẫn chiều.
 *
 * Phân công giáo viên (bảng giấy chỉ ghi tên cho Thứ 2, hai cột còn lại để trống):
 *   - Thứ 2 sáng   → cô Đinh Thị Thu Thảo ("Thảo")
 *   - Thứ 2 chiều  → cô Phan Hân Nghi ("Nghi")
 *   - Thứ 4, Thứ 5 → cô Đinh Thị Thu Thảo
 * Thứ 4/Thứ 5 ban đầu gán cho cô Nguyễn Trần Tâm, nhưng cả 7 tiết Thứ 4 trùng
 * khít giờ với lịch của cô ở TIỂU HỌC CẦU XÁNG (7:30/8:10/9:20/10:00/13:30/
 * 14:10/15:25) — không thể đứng hai trường cùng lúc. Cô Thảo đã dạy tại trường
 * này và trống hẳn T3→T6 nên nhận trọn hai ngày (17 tiết/tuần).
 *
 * Script KHÔNG tạo trường: `schools` phải có sẵn bản ghi trường này (Nhân sự
 * khai trên UI để có địa chỉ/toạ độ/bán kính check-in — thiếu toạ độ thì giáo
 * viên không check-in được, nên không tạo trường rỗng từ script).
 *
 * Chạy lại được nhiều lần: tra trước theo khoá tự nhiên rồi mới INSERT.
 *
 * Chạy: npm run seed:tkb-trinh-thi-doi
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
const SCHOOL_NAME_LIKE = '%TRỊNH THỊ DỐI%';
const SCHOOL_YEAR = '2026-2027';
const SUBJECT_NAME = 'Công dân số';
const SUBJECT_CATALOG_ID = 17;

/** Chốt theo id vì trong DB có nhiều giáo viên trùng tên gọi ("Thảo", "Nghi"). */
const TEACHERS = {
    thao: { id: 28, name: 'Đinh Thị Thu Thảo' },
    nghi: { id: 101, name: 'Phan Hân Nghi' },
} as const;

type TeacherKey = keyof typeof TEACHERS;

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
    teacher: TeacherKey;
}

const SLOTS: Slot[] = [
    // ===== SÁNG =====
    { session: 'morning', period: 1, dayOfWeek: 4, className: '1.4', teacher: 'thao' },
    { session: 'morning', period: 1, dayOfWeek: 5, className: '1.7', teacher: 'thao' },

    { session: 'morning', period: 2, dayOfWeek: 2, className: '2.5', teacher: 'thao' },
    { session: 'morning', period: 2, dayOfWeek: 4, className: '1.1', teacher: 'thao' },
    { session: 'morning', period: 2, dayOfWeek: 5, className: '1.2', teacher: 'thao' },

    { session: 'morning', period: 3, dayOfWeek: 2, className: '2.6', teacher: 'thao' },
    { session: 'morning', period: 3, dayOfWeek: 4, className: '1.9', teacher: 'thao' },
    { session: 'morning', period: 3, dayOfWeek: 5, className: '1.6', teacher: 'thao' },

    { session: 'morning', period: 4, dayOfWeek: 2, className: '2.7', teacher: 'thao' },
    { session: 'morning', period: 4, dayOfWeek: 4, className: '1.11', teacher: 'thao' },
    { session: 'morning', period: 4, dayOfWeek: 5, className: '1.10', teacher: 'thao' },

    // ===== CHIỀU =====
    { session: 'afternoon', period: 1, dayOfWeek: 2, className: '2.4', teacher: 'nghi' },
    { session: 'afternoon', period: 1, dayOfWeek: 4, className: '1.8', teacher: 'thao' },
    { session: 'afternoon', period: 1, dayOfWeek: 5, className: '2.1', teacher: 'thao' },

    { session: 'afternoon', period: 2, dayOfWeek: 2, className: '2.8', teacher: 'nghi' },
    { session: 'afternoon', period: 2, dayOfWeek: 4, className: '2.3', teacher: 'thao' },
    { session: 'afternoon', period: 2, dayOfWeek: 5, className: '2.2', teacher: 'thao' },

    { session: 'afternoon', period: 3, dayOfWeek: 4, className: '1.3', teacher: 'thao' },
    { session: 'afternoon', period: 3, dayOfWeek: 5, className: '1.5', teacher: 'thao' },
];

/** "1.11" → khối 1, "2.5" → khối 2. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className.split('.')[0]);
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
        for (const { id, name } of Object.values(TEACHERS)) {
            const teacher = await client.query(`SELECT name FROM teachers WHERE id = $1`, [id]);
            if (teacher.rowCount === 0) {
                throw new Error(`Không tìm thấy giáo viên id=${id}`);
            }
            if (teacher.rows[0].name !== name) {
                throw new Error(
                    `Giáo viên id=${id} tên "${teacher.rows[0].name}", không phải "${name}" — id có thể đã bị dùng lại.`,
                );
            }
            console.log(`✓ Giáo viên "${name}" (id=${id})`);
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
        // Khoá tự nhiên của một tiết là (trường, lớp, môn, thứ, giờ bắt đầu) — KHÔNG
        // gồm giáo viên, để chạy lại sau khi đổi phân công thì tiết cũ được chuyển
        // sang GV mới thay vì nhân đôi thành hai bản ghi trùng giờ trùng lớp.
        let created = 0;
        let reassigned = 0;
        let skipped = 0;
        for (const slot of SLOTS) {
            const [startTime, endTime] = (PERIOD_TIME[slot.session] as Record<
                number,
                readonly [string, string]
            >)[slot.period];
            const classId = classIds.get(slot.className)!;
            const { id: teacherId, name: teacherName } = TEACHERS[slot.teacher];

            const existing = await client.query(
                `SELECT id, teacher_id FROM teaching_schedules
                 WHERE school_id = $1 AND class_id = $2 AND subject_id = $3
                   AND day_of_week = $4 AND start_time = $5`,
                [schoolId, classId, subjectId, slot.dayOfWeek, startTime],
            );
            if (existing.rowCount! > 1) {
                throw new Error(
                    `Có ${existing.rowCount} mẫu lịch trùng cho lớp ${slot.className} T${slot.dayOfWeek} ${startTime} ` +
                    `(id: ${existing.rows.map((r) => r.id).join(', ')}) — dọn tay trước khi chạy lại.`,
                );
            }
            if (existing.rowCount === 1) {
                if (existing.rows[0].teacher_id === teacherId) {
                    skipped++;
                } else {
                    await client.query(
                        `UPDATE teaching_schedules SET teacher_id = $1, updated_at = now() WHERE id = $2`,
                        [teacherId, existing.rows[0].id],
                    );
                    console.log(
                        `~ ${slot.className} T${slot.dayOfWeek} ${startTime}: gv${existing.rows[0].teacher_id} → ${teacherName} (gv${teacherId})`,
                    );
                    reassigned++;
                }
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

        // Chặn phân công bất khả thi: cùng GV, cùng thứ, khung giờ chồng nhau ở hai trường.
        const clash = await client.query(
            `SELECT te.name, a.day_of_week, a.start_time, s1.name AS school_a, s2.name AS school_b
             FROM teaching_schedules a
             JOIN teaching_schedules b
               ON b.teacher_id = a.teacher_id AND b.day_of_week = a.day_of_week
              AND b.id <> a.id AND b.is_active
              AND b.start_time < a.end_time AND a.start_time < b.end_time
             JOIN teachers te ON te.id = a.teacher_id
             JOIN schools s1 ON s1.id = a.school_id
             JOIN schools s2 ON s2.id = b.school_id
             WHERE a.school_id = $1 AND a.is_active AND b.school_id <> a.school_id
             ORDER BY a.day_of_week, a.start_time`,
            [schoolId],
        );
        for (const r of clash.rows) {
            console.warn(
                `⚠ ${r.name} T${r.day_of_week} ${String(r.start_time).slice(0, 5)}: trùng giờ với "${r.school_b}"`,
            );
        }

        await client.query('COMMIT');
        console.log(
            `✓ Xong: ${created} mẫu lịch mới, ${reassigned} đổi giáo viên, ${skipped} giữ nguyên ` +
            `(tổng ${SLOTS.length} tiết/tuần).`,
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
