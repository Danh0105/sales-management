/**
 * Seed TKB KNS/STEM — THCS Đoàn Kết, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy: thầy Tăng Quốc Huy dạy toàn bộ 16 tiết/tuần
 * (4 tiết sáng Thứ 3 + Thứ 4, 12 tiết chiều Thứ 3 → Thứ 6).
 *
 * Tên lớp trong bảng đã kèm môn ("7/1 STEM", "8/2+8/4 KNS") và trường đang lưu
 * đúng quy ước đó từ năm 2025-2026 (khi ấy dùng dấu chấm: "7.1 STEM"), nên bản
 * này giữ tên đúng như bảng giấy mới. Môn của mỗi tiết suy ra từ hậu tố tên lớp.
 *
 * Script KHÔNG tạo trường: `schools` phải có sẵn bản ghi (Nhân sự khai trên UI
 * để có toạ độ/bán kính check-in).
 *
 * Chạy lại được nhiều lần: tra trước theo khoá tự nhiên rồi mới INSERT.
 *
 * Chạy: npm run seed:tkb-doan-ket
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME = 'THCS Đoàn Kết';
const SCHOOL_YEAR = '2026-2027';

/** Hai môn của TKB này — giữ đúng tên trường đã dùng ở năm 2025-2026. */
const SUBJECTS = {
    KNS: { name: 'Kỹ năng sống', catalogId: 6 },
    STEM: { name: 'STEM', catalogId: 14 },
} as const;

type SubjectKey = keyof typeof SUBJECTS;

/** Cùng khoảng hiệu lực với các TKB 2026-2027 khác. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Khung giờ từng tiết theo buổi, đúng cột "THỜI GIAN" của bảng TKB. */
const PERIOD_TIME = {
    morning: {
        1: ['07:30', '08:15'],
        2: ['08:15', '09:00'],
        3: ['09:30', '10:15'],
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

/** Giáo viên chốt theo id (bảng TKB chỉ ghi "Quốc Huy"). */
const TEACHER = { id: 26, name: 'Tăng Quốc Huy' } as const;

interface Slot {
    session: Session;
    period: 1 | 2 | 3 | 4;
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    /** Tên lớp kèm môn, đúng như bảng TKB. */
    className: string;
}

const SLOTS: Slot[] = [
    // ===== SÁNG ===== (Thứ 2, Thứ 5, Thứ 6 trống)
    { session: 'morning', period: 1, dayOfWeek: 4, className: '7/1 STEM' },
    { session: 'morning', period: 2, dayOfWeek: 4, className: '7/1 KNS' },
    { session: 'morning', period: 4, dayOfWeek: 3, className: '8/1 STEM' },
    { session: 'morning', period: 4, dayOfWeek: 4, className: '8/1 KNS' },

    // ===== CHIỀU — tiết 1 (13:30-14:15) ===== (Thứ 2 trống)
    { session: 'afternoon', period: 1, dayOfWeek: 3, className: '6/3 STEM' },
    { session: 'afternoon', period: 1, dayOfWeek: 4, className: '6/7 STEM' },
    { session: 'afternoon', period: 1, dayOfWeek: 5, className: '6/5 STEM' },
    { session: 'afternoon', period: 1, dayOfWeek: 6, className: '6/4 STEM' },

    // ===== CHIỀU — tiết 2 (14:15-15:00) =====
    { session: 'afternoon', period: 2, dayOfWeek: 3, className: '6/3 KNS' },
    { session: 'afternoon', period: 2, dayOfWeek: 4, className: '6/7 KNS' },
    { session: 'afternoon', period: 2, dayOfWeek: 5, className: '6/5 KNS' },
    { session: 'afternoon', period: 2, dayOfWeek: 6, className: '6/4 KNS' },

    // ===== CHIỀU — tiết 4 (16:15-17:00) ===== (tiết 3 trống cả tuần)
    { session: 'afternoon', period: 4, dayOfWeek: 3, className: '8/2+8/4 STEM' },
    { session: 'afternoon', period: 4, dayOfWeek: 4, className: '7/2+7/3 KNS' },
    { session: 'afternoon', period: 4, dayOfWeek: 5, className: '7/2+7/3 STEM' },
    { session: 'afternoon', period: 4, dayOfWeek: 6, className: '8/2+8/4 KNS' },
];

/** "8/2+8/4 KNS" → khối 8. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className[0]);
    return Number.isFinite(grade) ? grade : null;
}

/** "8/2+8/4 KNS" → KNS. Hậu tố tên lớp chính là môn trong bảng TKB. */
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
            `SELECT id, name FROM schools WHERE TRIM(name) = $1`,
            [SCHOOL_NAME],
        );
        if (school.rowCount === 0) {
            throw new Error(
                `Chưa có trường "${SCHOOL_NAME}" trong bảng schools.\n` +
                `→ Nhân sự tạo trường trên UI trước (kèm địa chỉ/toạ độ/bán kính check-in), rồi chạy lại script.`,
            );
        }
        if (school.rowCount! > 1) {
            throw new Error(
                `Có ${school.rowCount} trường trùng tên "${SCHOOL_NAME}": ` +
                school.rows.map((r) => `${r.id}=${r.name}`).join(', '),
            );
        }
        const schoolId: number = school.rows[0].id;
        console.log(`✓ Trường "${school.rows[0].name}" (id=${schoolId})`);

        // ===== Giáo viên =====
        const teacher = await client.query(`SELECT name FROM teachers WHERE id = $1`, [
            TEACHER.id,
        ]);
        if (teacher.rowCount === 0) {
            throw new Error(`Không tìm thấy giáo viên id=${TEACHER.id} ("${TEACHER.name}")`);
        }
        if (teacher.rows[0].name !== TEACHER.name) {
            throw new Error(
                `Giáo viên id=${TEACHER.id} tên "${teacher.rows[0].name}", không phải "${TEACHER.name}" — id có thể đã bị dùng lại.`,
            );
        }
        console.log(`✓ Giáo viên "${TEACHER.name}" (id=${TEACHER.id})`);

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
            const [startTime, endTime] = PERIOD_TIME[slot.session][slot.period];
            const classId = classIds.get(slot.className)!;
            const subjectId = subjectIds.get(subjectKeyOf(slot.className))!;

            const existing = await client.query(
                `SELECT id FROM teaching_schedules
                 WHERE teacher_id = $1 AND class_id = $2 AND subject_id = $3
                   AND day_of_week = $4 AND start_time = $5`,
                [TEACHER.id, classId, subjectId, slot.dayOfWeek, startTime],
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
                    TEACHER.id,
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
