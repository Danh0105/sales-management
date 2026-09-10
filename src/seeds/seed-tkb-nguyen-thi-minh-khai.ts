/**
 * Seed TKB CDS — Tiểu học Nguyễn Thị Minh Khai, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy của trường: cô Lưu Phan Thanh Trang dạy sáng Thứ 4 tại
 * CS3, cô Đỗ Lê Thạch Thảo dạy chiều Thứ 2 tại CS2 và chiều Thứ 4 tại CS3.
 * Mỗi ô trong bảng là 1 tiết cho 1 lớp.
 *
 * Trường chưa có cơ sở nào trong DB nên script tạo luôn CS2/CS3 (chưa có địa
 * chỉ, toạ độ — cần bổ sung sau để chấm công theo vị trí hoạt động đúng).
 *
 * Chạy lại được nhiều lần: mọi INSERT đều tra trước theo khoá tự nhiên (cơ sở
 * theo school+name, lớp theo school+name+year+location, lịch theo
 * teacher+class+subject+day+start_time) nên không sinh bản ghi trùng.
 *
 * Chạy: npm run seed:tkb-nguyen-thi-minh-khai
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

const SCHOOL_NAME = 'TIỂU HỌC NGUYỄN THỊ MINH KHAI';
const SCHOOL_YEAR = '2026-2027';
const SUBJECT_NAME = 'CDS';
/** Môn trong danh mục dùng chung — theo môn CDS đã có sẵn của trường này. */
const SUBJECT_CATALOG_ID = 3;

/** Khớp với khoảng hiệu lực đang dùng cho phần lớn lịch năm 2026-2027. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Khung giờ từng tiết theo buổi, đúng cột "THỜI GIAN" của bảng TKB. */
const PERIOD_TIME = {
    morning: {
        1: ['07:30', '08:05'],
        2: ['08:10', '08:45'],
        3: ['09:15', '09:50'],
        4: ['09:55', '10:30'],
    },
    afternoon: {
        1: ['13:30', '14:05'],
        2: ['14:10', '14:45'],
        3: ['15:15', '15:50'],
        4: ['15:55', '16:30'],
    },
} as const;

type Session = keyof typeof PERIOD_TIME;

interface Slot {
    teacher: string;
    /** Tên cơ sở trong bảng TKB: 'CS2' hoặc 'CS3'. */
    location: string;
    session: Session;
    period: 1 | 2 | 3 | 4;
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    className: string;
}

const TRANG = 'Lưu Phan Thanh Trang';
const THAO = 'Đỗ Lê Thạch Thảo';

const LOCATION_NAMES = ['CS2', 'CS3'];

const SLOTS: Slot[] = [
    // ===== THỨ 4 — SÁNG, CS3, cô Trang =====
    { teacher: TRANG, location: 'CS3', session: 'morning', period: 1, dayOfWeek: 4, className: '3/4' },
    { teacher: TRANG, location: 'CS3', session: 'morning', period: 2, dayOfWeek: 4, className: '3/2' },
    { teacher: TRANG, location: 'CS3', session: 'morning', period: 3, dayOfWeek: 4, className: '3/3' },
    { teacher: TRANG, location: 'CS3', session: 'morning', period: 4, dayOfWeek: 4, className: '3/1' },

    // ===== THỨ 2 — CHIỀU, CS2, cô Thảo (tiết 4 trống) =====
    { teacher: THAO, location: 'CS2', session: 'afternoon', period: 1, dayOfWeek: 2, className: '4/2' },
    { teacher: THAO, location: 'CS2', session: 'afternoon', period: 2, dayOfWeek: 2, className: '5/1' },
    { teacher: THAO, location: 'CS2', session: 'afternoon', period: 3, dayOfWeek: 2, className: '5/2' },

    // ===== THỨ 4 — CHIỀU, CS3, cô Thảo (tiết 4 trống) =====
    { teacher: THAO, location: 'CS3', session: 'afternoon', period: 1, dayOfWeek: 4, className: '2/1' },
    { teacher: THAO, location: 'CS3', session: 'afternoon', period: 2, dayOfWeek: 4, className: '2/2' },
    { teacher: THAO, location: 'CS3', session: 'afternoon', period: 3, dayOfWeek: 4, className: '4/1' },
];

/** "3/4" → khối 3. */
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
        const school = await client.query(`SELECT id FROM schools WHERE name = $1`, [
            SCHOOL_NAME,
        ]);
        if (school.rowCount === 0) {
            throw new Error(`Không tìm thấy trường "${SCHOOL_NAME}"`);
        }
        const schoolId: number = school.rows[0].id;
        console.log(`✓ Trường "${SCHOOL_NAME}" (id=${schoolId})`);

        // ===== Cơ sở =====
        const locationIds = new Map<string, number>();
        for (const name of LOCATION_NAMES) {
            let loc = await client.query(
                `SELECT id FROM school_locations WHERE school_id = $1 AND name = $2`,
                [schoolId, name],
            );
            if (loc.rowCount === 0) {
                loc = await client.query(
                    `INSERT INTO school_locations (school_id, name) VALUES ($1, $2) RETURNING id`,
                    [schoolId, name],
                );
                console.log(`+ Cơ sở ${name} (id=${loc.rows[0].id}) — chưa có địa chỉ/toạ độ`);
            } else {
                console.log(`· Cơ sở ${name} đã có (id=${loc.rows[0].id})`);
            }
            locationIds.set(name, loc.rows[0].id);
        }

        // ===== Giáo viên =====
        const teacherIds = new Map<string, number>();
        for (const name of [TRANG, THAO]) {
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

        // ===== Môn học =====
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

        // ===== Lớp học ===== (lớp thuộc cơ sở nào thì gắn cơ sở đó)
        const classKey = (s: Slot) => `${s.location}|${s.className}`;
        const classes = [...new Map(SLOTS.map((s) => [classKey(s), s])).values()];
        const classIds = new Map<string, number>();
        for (const slot of classes) {
            const locationId = locationIds.get(slot.location)!;
            let cls = await client.query(
                `SELECT id FROM school_classes
                 WHERE school_id = $1 AND name = $2 AND school_year = $3
                   AND school_location_id = $4`,
                [schoolId, slot.className, SCHOOL_YEAR, locationId],
            );
            if (cls.rowCount === 0) {
                cls = await client.query(
                    `INSERT INTO school_classes
                       (school_id, name, grade_level, school_year, school_location_id)
                     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                    [
                        schoolId,
                        slot.className,
                        gradeLevelOf(slot.className),
                        SCHOOL_YEAR,
                        locationId,
                    ],
                );
                console.log(`+ Lớp ${slot.className} (${slot.location}, id=${cls.rows[0].id})`);
            }
            const classId: number = cls.rows[0].id;
            classIds.set(classKey(slot), classId);

            // Môn được tổ chức dạy tại lớp này.
            await client.query(
                `INSERT INTO school_class_subjects (class_id, subject_id)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [classId, subjectId],
            );
        }
        await client.query(`UPDATE subjects SET class_count = $1 WHERE id = $2`, [
            classes.length,
            subjectId,
        ]);

        // ===== Mẫu lịch =====
        let created = 0;
        let skipped = 0;
        for (const slot of SLOTS) {
            const [startTime, endTime] = PERIOD_TIME[slot.session][slot.period];
            const teacherId = teacherIds.get(slot.teacher)!;
            const classId = classIds.get(classKey(slot))!;

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
                   (teacher_id, school_id, school_location_id, class_id, subject_id,
                    day_of_week, start_time, end_time, periods, effective_from,
                    effective_to, is_active, note)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, true, $11)`,
                [
                    teacherId,
                    schoolId,
                    locationIds.get(slot.location)!,
                    classId,
                    subjectId,
                    slot.dayOfWeek,
                    startTime,
                    endTime,
                    EFFECTIVE_FROM,
                    EFFECTIVE_TO,
                    `TKB ${SCHOOL_YEAR} — ${slot.location}, tiết ${slot.period} ${slot.session === 'morning' ? 'sáng' : 'chiều'}`,
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
