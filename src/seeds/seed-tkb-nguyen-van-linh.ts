/**
 * Seed TKB CDS/THQT — Trường THCS Nguyễn Văn Linh, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy: thầy Ôn Đình Phúc dạy 21 tiết/tuần cho khối 6
 * (4 tiết sáng Thứ 3, còn lại buổi chiều Thứ 2 → Thứ 6), gồm 2 môn THQT và CDS
 * — môn ghi ngay sau tên lớp trong từng ô ("6.2 THQT", "6.8 CDS").
 *
 * Bảng có 2 cột song song ở Thứ 3 và Thứ 5. Cột phụ (6 tiết CDS: Thứ 3 tiết
 * 2/3/4 = 6.6, 6.7, 6.9; Thứ 5 tiết 2/3/4 = 6.3, 6.5, 6.2) KHÔNG ghi tên giáo
 * viên nên chưa seed — bổ sung khi trường xác nhận ai dạy.
 *
 * Script KHÔNG tạo trường: `schools` phải có sẵn bản ghi (Nhân sự khai trên UI
 * để có toạ độ/bán kính check-in). Tính tới lúc viết script, trường này CHƯA có
 * trong DB nên chạy sẽ báo lỗi cho tới khi Nhân sự tạo xong.
 *
 * Chạy lại được nhiều lần: tra trước theo khoá tự nhiên rồi mới INSERT.
 *
 * Chạy: npm run seed:tkb-nguyen-van-linh
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME_LIKE = '%NGUYỄN VĂN LINH%';
const SCHOOL_YEAR = '2026-2027';

/**
 * Hai môn của TKB này. THQT chưa có trong `subject_catalogs` nên script tự tạo
 * bản ghi catalog (khoá tự nhiên là `name`, có UNIQUE nên chạy lại không nhân bản).
 */
const SUBJECTS = {
    THQT: { name: 'THQT', catalogName: 'THQT' },
    CDS: { name: 'CDS', catalogName: 'CDS' },
} as const;

type SubjectKey = keyof typeof SUBJECTS;

/** Giáo viên "Phúc" trong bảng — chốt theo id vì có 4 giáo viên trùng tên gọi. */
const TEACHER_ID = 228;
const TEACHER_NAME = 'Ôn Đình Phúc';

/** Cùng khoảng hiệu lực với các TKB 2026-2027 khác. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Cột "THỜI GIAN" của bảng TKB. */
const PERIOD_TIME = {
    morning: {
        1: ['07:30', '08:15'],
        2: ['08:15', '09:00'],
        3: ['09:30', '10:15'],
        4: ['10:15', '11:00'],
    },
    afternoon: {
        1: ['13:30', '14:15'],
        2: ['14:20', '15:05'],
        3: ['15:30', '16:15'],
        4: ['16:20', '17:05'],
    },
} as const;

type Session = keyof typeof PERIOD_TIME;

interface Slot {
    session: Session;
    period: 1 | 2 | 3 | 4;
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    /** Tên lớp kèm môn, đúng như ô trong bảng TKB. */
    className: string;
}

const SLOTS: Slot[] = [
    // ===== SÁNG — chỉ Thứ 3 (6.4 học liền 2 tiết 3-4) =====
    { session: 'morning', period: 1, dayOfWeek: 3, className: '6.2 THQT' },
    { session: 'morning', period: 2, dayOfWeek: 3, className: '6.8 THQT' },
    { session: 'morning', period: 3, dayOfWeek: 3, className: '6.4 THQT' },
    { session: 'morning', period: 4, dayOfWeek: 3, className: '6.4 THQT' },

    // ===== CHIỀU — tiết 1 (13:30 - 14:15) =====
    { session: 'afternoon', period: 1, dayOfWeek: 2, className: '6.6 THQT' },
    { session: 'afternoon', period: 1, dayOfWeek: 3, className: '6.1 THQT' },
    { session: 'afternoon', period: 1, dayOfWeek: 4, className: '6.8 CDS' },
    { session: 'afternoon', period: 1, dayOfWeek: 5, className: '6.7 THQT' },
    { session: 'afternoon', period: 1, dayOfWeek: 6, className: '6.5 THQT' },

    // ===== CHIỀU — tiết 2 (14:20 - 15:05) =====
    { session: 'afternoon', period: 2, dayOfWeek: 2, className: '6.1 THQT' },
    { session: 'afternoon', period: 2, dayOfWeek: 3, className: '6.7 THQT' },
    { session: 'afternoon', period: 2, dayOfWeek: 4, className: '6.1 CDS' },
    { session: 'afternoon', period: 2, dayOfWeek: 5, className: '6.9 THQT' },
    { session: 'afternoon', period: 2, dayOfWeek: 6, className: '6.9 THQT' },

    // ===== CHIỀU — tiết 3 (15:30 - 16:15) =====
    { session: 'afternoon', period: 3, dayOfWeek: 2, className: '6.8 THQT' },
    { session: 'afternoon', period: 3, dayOfWeek: 3, className: '6.6 THQT' },
    { session: 'afternoon', period: 3, dayOfWeek: 4, className: '6.4 CDS' },
    { session: 'afternoon', period: 3, dayOfWeek: 5, className: '6.3 THQT' },
    { session: 'afternoon', period: 3, dayOfWeek: 6, className: '6.2 THQT' },

    // ===== CHIỀU — tiết 4 (16:20 - 17:05) ===== (6.3 học liền 2 tiết 3-4 Thứ 5)
    { session: 'afternoon', period: 4, dayOfWeek: 3, className: '6.5 THQT' },
    { session: 'afternoon', period: 4, dayOfWeek: 5, className: '6.3 THQT' },
];

/** "6.2 THQT" → khối 6. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className.split('.')[0]);
    return Number.isFinite(grade) ? grade : null;
}

/** "6.2 THQT" → THQT. Hậu tố tên lớp chính là môn trong bảng TKB. */
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
        const teacher = await client.query(`SELECT name FROM teachers WHERE id = $1`, [
            TEACHER_ID,
        ]);
        if (teacher.rowCount === 0) {
            throw new Error(`Không tìm thấy giáo viên id=${TEACHER_ID} ("${TEACHER_NAME}")`);
        }
        if (teacher.rows[0].name !== TEACHER_NAME) {
            throw new Error(
                `Giáo viên id=${TEACHER_ID} tên "${teacher.rows[0].name}", không phải "${TEACHER_NAME}" — id có thể đã bị dùng lại.`,
            );
        }
        console.log(`✓ Giáo viên "${TEACHER_NAME}" (id=${TEACHER_ID})`);

        // ===== Danh mục môn dùng chung ===== (THQT chưa có → tạo mới)
        const catalogIds = new Map<SubjectKey, number>();
        for (const key of Object.keys(SUBJECTS) as SubjectKey[]) {
            const { catalogName } = SUBJECTS[key];
            let catalog = await client.query(
                `SELECT id FROM subject_catalogs WHERE TRIM(name) = $1 ORDER BY id`,
                [catalogName],
            );
            if (catalog.rowCount === 0) {
                catalog = await client.query(
                    `INSERT INTO subject_catalogs (name) VALUES ($1) RETURNING id`,
                    [catalogName],
                );
                console.log(`+ Danh mục môn "${catalogName}" (id=${catalog.rows[0].id})`);
            } else {
                console.log(`· Danh mục môn "${catalogName}" đã có (id=${catalog.rows[0].id})`);
            }
            catalogIds.set(key, catalog.rows[0].id);
        }

        // ===== Môn học của trường ===== (TRIM: dữ liệu cũ có tên môn dư khoảng trắng)
        const subjectIds = new Map<SubjectKey, number>();
        for (const key of Object.keys(SUBJECTS) as SubjectKey[]) {
            const { name } = SUBJECTS[key];
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
                    [name, schoolId, SCHOOL_YEAR, catalogIds.get(key)],
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
                [TEACHER_ID, classId, subjectId, slot.dayOfWeek, startTime],
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
                    TEACHER_ID,
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
        console.log(
            '· Còn 6 tiết CDS ở cột song song (Thứ 3 tiết 2/3/4, Thứ 5 tiết 2/3/4) chưa seed vì bảng không ghi tên giáo viên.',
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
