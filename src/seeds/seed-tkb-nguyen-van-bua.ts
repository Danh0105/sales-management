/**
 * Seed TKB STEM/AI — THCS Nguyễn Văn Bứa, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy của trường: thầy Nguyễn Châu Hải Dương dạy AI cho 12
 * lớp 9, cô Nguyễn Ngô Mỹ Ngân dạy STEM cho 10 lớp 6. Mỗi ô là 1 tiết cho 1
 * lớp; Thứ 3, Thứ 4 và Thứ 6 có 2 cột song song (AI và STEM cùng khung giờ).
 *
 * Bảng giấy ghi "2025-2026" nhưng lịch được gắn cho năm học 2026-2027 theo
 * thống nhất với các TKB còn lại.
 *
 * Chạy lại được nhiều lần: mọi INSERT đều tra trước theo khoá tự nhiên nên
 * không sinh bản ghi trùng.
 *
 * Chạy: npm run seed:tkb-nguyen-van-bua
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME = 'TRUNG HỌC CƠ SỞ NGUYỄN VĂN BỨA';
const SCHOOL_YEAR = '2026-2027';

/** Hai môn của TKB này, kèm mục tương ứng trong danh mục dùng chung. */
const SUBJECTS = {
    AI: { name: 'AI', catalogId: 21 },
    STEM: { name: 'STEM', catalogId: 14 },
} as const;

type SubjectKey = keyof typeof SUBJECTS;

/** Khớp với khoảng hiệu lực đang dùng cho phần lớn lịch năm 2026-2027. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Khung giờ từng tiết theo buổi, đúng cột "THỜI GIAN" của bảng TKB. */
const PERIOD_TIME = {
    morning: {
        1: ['07:15', '08:05'],
        2: ['08:05', '08:50'],
        3: ['09:25', '10:15'],
        4: ['10:15', '11:00'],
    },
    afternoon: {
        1: ['13:30', '14:15'],
        2: ['14:15', '15:00'],
        3: ['15:25', '16:10'],
        4: ['16:10', '16:55'],
    },
} as const;

type Session = keyof typeof PERIOD_TIME;

interface Slot {
    teacher: string;
    subject: SubjectKey;
    session: Session;
    period: 1 | 2 | 3 | 4;
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    className: string;
}

const DUONG = 'Nguyễn Châu Hải Dương';
const NGAN = 'Nguyễn Ngô Mỹ Ngân';

/** Cột AI của thầy Dương: [thứ, lớp tiết 1, lớp tiết 2, lớp tiết 3]. */
const AI_COLUMNS: [number, string, string, string][] = [
    [2, '9/4', '9/8', '9/7'],
    [3, '9/6', '9/2', '9/9'],
    [4, '9/3', '9/1', '9/5'],
    [6, '9/10', '9/11', '9/12'],
];

/** Cột STEM của cô Ngân: [thứ, lớp tiết 1, lớp tiết 2 (null = trống), lớp tiết 3]. */
const STEM_COLUMNS: [number, string, string | null, string][] = [
    [3, '6/3', '6/2', '6/6'],
    [4, '6/7', '6/9', '6/1'],
    [5, '6/5', null, '6/10'],
    [6, '6/4', null, '6/8'],
];

const SLOTS: Slot[] = [
    ...AI_COLUMNS.flatMap(([dayOfWeek, ...classes]) =>
        classes.map((className, index) => ({
            teacher: DUONG,
            subject: 'AI' as SubjectKey,
            session: 'afternoon' as Session,
            period: (index + 1) as 1 | 2 | 3,
            dayOfWeek,
            className,
        })),
    ),
    ...STEM_COLUMNS.flatMap(([dayOfWeek, ...classes]) =>
        classes.flatMap((className, index) =>
            className === null
                ? []
                : [
                      {
                          teacher: NGAN,
                          subject: 'STEM' as SubjectKey,
                          session: 'afternoon' as Session,
                          period: (index + 1) as 1 | 2 | 3,
                          dayOfWeek,
                          className,
                      },
                  ],
        ),
    ),
];

/** "9/12" → khối 9. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className.split('/')[0]);
    return Number.isFinite(grade) ? grade : null;
}

async function main() {
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
        const schoolId: number = school.rows[0].id;
        console.log(`✓ Trường "${SCHOOL_NAME}" (id=${schoolId})`);

        // ===== Giáo viên =====
        const teacherIds = new Map<string, number>();
        for (const name of [DUONG, NGAN]) {
            const found = await client.query(`SELECT id FROM teachers WHERE name = $1`, [
                name,
            ]);
            if (found.rowCount === 0) {
                throw new Error(`Không tìm thấy giáo viên "${name}"`);
            }
            if (found.rowCount! > 1) {
                throw new Error(`Có ${found.rowCount} giáo viên trùng tên "${name}"`);
            }
            teacherIds.set(name, found.rows[0].id);
            console.log(`✓ Giáo viên "${name}" (id=${found.rows[0].id})`);
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
                // `code` được sinh từ chính id (quy ước SUB<id> như dữ liệu sẵn có).
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

        // ===== Lớp học ===== (mỗi lớp chỉ học 1 trong 2 môn)
        const classSubject = new Map<string, SubjectKey>();
        for (const slot of SLOTS) classSubject.set(slot.className, slot.subject);
        const classIds = new Map<string, number>();
        for (const [name, subjectKey] of classSubject) {
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
                [classId, subjectIds.get(subjectKey)!],
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
            const teacherId = teacherIds.get(slot.teacher)!;
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
                    `TKB ${SCHOOL_YEAR} — ${SUBJECTS[slot.subject].name}, tiết ${slot.period} chiều`,
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
