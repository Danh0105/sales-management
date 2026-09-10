/**
 * Seed TKB STEM — Tiểu học Tạ Uyên, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy của trường. Bảng chỉ có buổi CHIỀU, tiết 5-8, và mỗi
 * thứ có 2 cột song song (2 giáo viên dạy cùng khung giờ):
 *   - thầy Ngụy Phú Tài         — cột chính, cả 5 ngày
 *   - thầy Nguyễn Văn Trường An — cột phụ
 *   - thầy Dương Hoàng Sơn      — chỉ 2 tiết chiều Thứ 3 (cột phụ)
 *
 * Ba ô 1.3 (T6 tiết 6), 4.4 và 3.6 (T6 tiết 7/8) trong bảng giấy bỏ trống cột
 * "GV DẠY"; theo cột đang đứng thì đó là thầy Tài — DB hiện tại cũng đang gán
 * thầy Tài, nên seed giữ nguyên như vậy.
 *
 * Trường có cơ sở 2: tên lớp trong bảng ghi kèm ("5.8 CS2"). DB của trường này
 * CHƯA khai school_locations, nên "CS2" được giữ nguyên trong TÊN LỚP (đúng
 * như 30 lớp đang có), không tách sang school_location_id.
 *
 * Chạy lại được nhiều lần: mọi INSERT đều tra trước theo khoá tự nhiên nên
 * không sinh bản ghi trùng.
 *
 * Chạy: npm run seed:tkb-ta-uyen
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME = 'TH TẠ UYÊN';
const SCHOOL_YEAR = '2026-2027';
const SUBJECT_NAME = 'STEM';
/** Môn STEM trong danh mục dùng chung. */
const SUBJECT_CATALOG_ID = 14;

const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/**
 * Khung giờ từng tiết, đúng cột "THỜI GIAN" của bảng TKB (chỉ buổi chiều).
 * Giữa tiết 6 và 7 có nghỉ giải lao 14:45-15:15.
 */
const PERIOD_TIME = {
    5: ['13:30', '14:05'],
    6: ['14:10', '14:45'],
    7: ['15:20', '15:55'],
    8: ['16:00', '16:35'],
} as const;

type Period = keyof typeof PERIOD_TIME;

interface Slot {
    teacher: string;
    period: Period;
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    className: string;
}

const TAI = 'Ngụy Phú Tài';
const AN = 'Nguyễn Văn Trường An';
const SON = 'Dương Hoàng Sơn';

const SLOTS: Slot[] = [
    // ===== Tiết 5 — 13:30-14:05 =====
    { teacher: TAI, dayOfWeek: 3, period: 5, className: '5.8 CS2' },
    { teacher: TAI, dayOfWeek: 4, period: 5, className: '3.3' },
    { teacher: AN, dayOfWeek: 4, period: 5, className: '3.4' },
    { teacher: TAI, dayOfWeek: 5, period: 5, className: '2.6 CS2' },

    // ===== Tiết 6 — 14:10-14:45 =====
    { teacher: TAI, dayOfWeek: 2, period: 6, className: '5.4' },
    { teacher: AN, dayOfWeek: 2, period: 6, className: '5.5' },
    { teacher: TAI, dayOfWeek: 3, period: 6, className: '5.7 CS2' },
    { teacher: TAI, dayOfWeek: 5, period: 6, className: '3.5' },
    { teacher: AN, dayOfWeek: 5, period: 6, className: '5.1' },
    { teacher: TAI, dayOfWeek: 6, period: 6, className: '1.3' }, // bảng để trống GV

    // ===== Tiết 7 — 15:20-15:55 =====
    { teacher: TAI, dayOfWeek: 2, period: 7, className: '1.1' },
    { teacher: AN, dayOfWeek: 2, period: 7, className: '4.5' },
    { teacher: TAI, dayOfWeek: 3, period: 7, className: '3.2' },
    { teacher: SON, dayOfWeek: 3, period: 7, className: '5.2' },
    { teacher: TAI, dayOfWeek: 4, period: 7, className: '1.5' },
    { teacher: AN, dayOfWeek: 4, period: 7, className: '4.1' },
    { teacher: TAI, dayOfWeek: 5, period: 7, className: '2.2' },
    { teacher: AN, dayOfWeek: 5, period: 7, className: '3.7 CS2' },
    { teacher: TAI, dayOfWeek: 6, period: 7, className: '4.4' }, // bảng để trống GV
    { teacher: AN, dayOfWeek: 6, period: 7, className: '4.7 CS2' },

    // ===== Tiết 8 — 16:00-16:35 =====
    { teacher: TAI, dayOfWeek: 2, period: 8, className: '1.2' },
    { teacher: AN, dayOfWeek: 2, period: 8, className: '4.2' },
    { teacher: TAI, dayOfWeek: 3, period: 8, className: '2.3' },
    { teacher: SON, dayOfWeek: 3, period: 8, className: '2.5' },
    { teacher: TAI, dayOfWeek: 4, period: 8, className: '2.1' },
    { teacher: AN, dayOfWeek: 4, period: 8, className: '5.3' },
    { teacher: TAI, dayOfWeek: 5, period: 8, className: '2.5' },
    { teacher: AN, dayOfWeek: 5, period: 8, className: '3.1' },
    { teacher: TAI, dayOfWeek: 6, period: 8, className: '3.6' }, // bảng để trống GV
    { teacher: AN, dayOfWeek: 6, period: 8, className: '4.3' },
];

/** "5.8 CS2" → khối 5. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className.split('.')[0]);
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

        // ===== Trường ===== (DB còn một "Tiểu Học Tạ Uyên" cũ, khớp tên chính xác)
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

        // ===== Giáo viên =====
        const teacherIds = new Map<string, number>();
        for (const name of [TAI, AN, SON]) {
            const found = await client.query(`SELECT id FROM teachers WHERE name = $1`, [name]);
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
        let subject = await client.query(
            `SELECT id FROM subjects
             WHERE school_id = $1 AND TRIM(name) = $2 AND school_year = $3
             ORDER BY id`,
            [schoolId, SUBJECT_NAME, SCHOOL_YEAR],
        );
        if (subject.rowCount === 0) {
            subject = await client.query(
                `INSERT INTO subjects (name, school_id, school_year, catalog_id)
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [SUBJECT_NAME, schoolId, SCHOOL_YEAR, SUBJECT_CATALOG_ID],
            );
            // `code` được sinh từ chính id (quy ước SUB<id> như dữ liệu sẵn có).
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
                 WHERE school_id = $1 AND UPPER(name) = UPPER($2) AND school_year = $3`,
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

            // Khớp theo giờ KẾT THÚC: dữ liệu nhập trước đó có tiết 8 lệch giờ
            // bắt đầu (16:20 thay vì 16:00), khớp theo start_time sẽ nhân đôi.
            const existing = await client.query(
                `SELECT id FROM teaching_schedules
                 WHERE teacher_id = $1 AND class_id = $2 AND subject_id = $3
                   AND day_of_week = $4 AND end_time = $5`,
                [teacherId, classId, subjectId, slot.dayOfWeek, endTime],
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
