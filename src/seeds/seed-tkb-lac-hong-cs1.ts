/**
 * Seed TKB Kỹ năng sống — THCS Lạc Hồng, CƠ SỞ 1, năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy phần CS1 (6 tiết/tuần, chỉ buổi sáng). Ba giáo viên:
 * cô Nguyễn Ngọc Phương Nghi (4 tiết), cô Huỳnh Thị Hải Triều (1 tiết),
 * cô Trần Thị Quỳnh Mai (1 tiết).
 *
 * Tên lớp trong bảng ghi kèm cơ sở ("8/6 CS1"). Trong DB cơ sở nằm ở
 * school_classes.school_location_id, tên lớp chỉ giữ phần "8/6".
 *
 * Khác biệt so với bảng cũ (seed-tkb-lac-hong.ts): tiết 8/7 của cô Quỳnh Mai
 * chuyển từ Thứ 4 sang Thứ 3 (vẫn tiết 3, 9:15-10:00). Seed này TẮT
 * (is_active = false) mọi mẫu lịch Kỹ năng sống 2026-2027 của CS1 không còn
 * nằm trong bảng — bao gồm bản ghi Thứ 4 cũ — thay vì xoá, để giữ lại đối chiếu.
 * Các cơ sở khác (CS2, Phân hiệu) không bị đụng tới.
 *
 * Chạy lại được nhiều lần: mọi INSERT đều tra trước theo khoá tự nhiên nên
 * không sinh bản ghi trùng.
 *
 * Chạy: npm run seed:tkb-lac-hong-cs1
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
const SUBJECT_NAME = 'Kỹ năng sống';
/** Môn Kỹ năng sống trong danh mục dùng chung. */
const SUBJECT_CATALOG_ID = 6;

const CAMPUS = 'CS1';

const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Khung giờ từng tiết, đúng cột "THỜI GIAN" của bảng TKB. */
const PERIOD_TIME = {
    1: ['07:15', '08:00'],
    2: ['08:00', '08:45'],
    3: ['09:15', '10:00'],
    4: ['10:00', '10:45'],
    5: ['10:45', '11:30'],
} as const;

type Period = keyof typeof PERIOD_TIME;

interface Slot {
    teacher: string;
    period: Period;
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    className: string;
}

const NGHI = 'Nguyễn Ngọc Phương Nghi';
const TRIEU = 'Huỳnh Thị Hải Triều';
const MAI = 'Trần Thị Quỳnh Mai';

const SLOTS: Slot[] = [
    // ===== THỨ 3 =====
    { teacher: NGHI, dayOfWeek: 3, period: 1, className: '8/6' },
    { teacher: NGHI, dayOfWeek: 3, period: 2, className: '6/6' },
    { teacher: MAI, dayOfWeek: 3, period: 3, className: '8/7' },

    // ===== THỨ 5 =====
    { teacher: NGHI, dayOfWeek: 5, period: 1, className: '8/8' },
    { teacher: TRIEU, dayOfWeek: 5, period: 4, className: '6/5' },
    { teacher: NGHI, dayOfWeek: 5, period: 4, className: '8/5' },
];

/** "8/6" → khối 8. */
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

        // ===== Cơ sở ===== (mỗi cơ sở có toạ độ check-in riêng, phải khai sẵn trên UI)
        const campus = await client.query(
            `SELECT id FROM school_locations WHERE school_id = $1 AND name = $2`,
            [schoolId, CAMPUS],
        );
        if (campus.rowCount === 0) {
            throw new Error(`Chưa có cơ sở "${CAMPUS}" của trường id=${schoolId} trong school_locations.`);
        }
        const locationId: number = campus.rows[0].id;
        console.log(`✓ Cơ sở ${CAMPUS} (id=${locationId})`);

        // ===== Giáo viên =====
        const teacherIds = new Map<string, number>();
        for (const name of [NGHI, TRIEU, MAI]) {
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
                console.log(`+ Lớp ${className} (${CAMPUS}, id=${cls.rows[0].id})`);
            } else if (cls.rows[0].school_location_id !== locationId) {
                // Bản ghi cũ có thể được tạo thiếu/sai cơ sở — sửa lại theo bảng TKB.
                await client.query(
                    `UPDATE school_classes SET school_location_id = $1, updated_at = now()
                     WHERE id = $2`,
                    [locationId, cls.rows[0].id],
                );
                console.log(`~ Lớp ${className}: cơ sở → ${CAMPUS} (${locationId})`);
            }
            const classId: number = cls.rows[0].id;
            classIds.set(className, classId);

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
        const keepIds: number[] = [];
        for (const slot of SLOTS) {
            const [startTime, endTime] = PERIOD_TIME[slot.period];
            const teacherId = teacherIds.get(slot.teacher)!;
            const classId = classIds.get(slot.className)!;

            const existing = await client.query(
                `SELECT id FROM teaching_schedules
                 WHERE teacher_id = $1 AND class_id = $2 AND subject_id = $3
                   AND day_of_week = $4 AND start_time = $5`,
                [teacherId, classId, subjectId, slot.dayOfWeek, startTime],
            );
            if (existing.rowCount! > 0) {
                // Bật lại nếu trước đó bị tắt bởi một lần chạy seed khác.
                await client.query(
                    `UPDATE teaching_schedules SET is_active = true, updated_at = now()
                     WHERE id = $1 AND is_active = false`,
                    [existing.rows[0].id],
                );
                keepIds.push(existing.rows[0].id);
                skipped++;
                continue;
            }

            const inserted = await client.query(
                `INSERT INTO teaching_schedules
                   (teacher_id, school_id, class_id, subject_id, day_of_week,
                    start_time, end_time, periods, effective_from, effective_to,
                    is_active, note)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, true, $10)
                 RETURNING id`,
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
                    `TKB ${SCHOOL_YEAR} — tiết ${slot.period} sáng, ${CAMPUS}`,
                ],
            );
            keepIds.push(inserted.rows[0].id);
            created++;
        }

        // ===== Tắt mẫu lịch CS1 không còn trong bảng ===== (vd. 8/7 Thứ 4 cũ)
        const stale = await client.query(
            `UPDATE teaching_schedules ts
             SET is_active = false, updated_at = now()
             FROM school_classes c
             WHERE c.id = ts.class_id
               AND ts.school_id = $1
               AND ts.subject_id = $2
               AND c.school_location_id = $3
               AND ts.is_active = true
               AND NOT (ts.id = ANY($4::int[]))`,
            [schoolId, subjectId, locationId, keepIds],
        );

        await client.query('COMMIT');
        console.log(
            `✓ Xong: ${created} mẫu lịch mới, ${skipped} đã có sẵn (tổng ${SLOTS.length} tiết/tuần ${CAMPUS}); ` +
                `${stale.rowCount} mẫu lịch ${CAMPUS} cũ ngoài bảng đã tắt.`,
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
