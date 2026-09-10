/**
 * Seed TKB STEM/ROBOT — TIỂU HỌC HÒA BÌNH (id=480), năm học 2026-2027.
 *
 * Nhập từ bảng TKB giấy: 15 lớp, mỗi lớp đúng 1 tiết/tuần, trải T2→T6 ở hai cơ sở:
 *   - CS1: Số 1 Công xã Paris, phường Bến Nghé, Quận 1
 *   - CS2: 77 Tôn Thất Đạm, phường Bến Nghé, Quận 1
 * Tên lớp trong bảng ghi kèm cơ sở ("1/4 CS2") — trong DB cơ sở nằm ở
 * school_classes.school_location_id, tên lớp chỉ giữ phần "1/4".
 *
 * Hai tiết CLB ROBOT (16:00-16:45, T5 ở CS1 và T6 ở CS2) KHÔNG được seed: bảng
 * giấy không ghi lớp lẫn giáo viên cho hai ô này.
 *
 * Bảng giấy đề "NĂM HỌC 2025-2026" nhưng dữ liệu trường này trong DB (lớp, môn
 * STEM, TKB) nằm ở 2026-2027 và khớp đúng bảng — đã xác nhận seed vào 2026-2027.
 * Ô "Chi" của lớp 5/1 T6 là cô Vũ Thị Kim Chi (đã xác nhận).
 *
 * Script KHÔNG tạo trường: `schools` phải có sẵn bản ghi trường này (Nhân sự
 * khai trên UI để có địa chỉ/toạ độ/bán kính check-in). Cơ sở CS1/CS2 cũng phải
 * có sẵn trong `school_locations` vì mỗi cơ sở cần toạ độ check-in riêng.
 *
 * Chạy lại được nhiều lần: tra trước theo khoá tự nhiên rồi mới INSERT.
 *
 * Chạy: npm run seed:tkb-hoa-binh
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

/** Chốt theo id: trong `schools` có hai bản ghi tên "Hòa Bình" (427 và 480). */
const SCHOOL_ID = 480;
const SCHOOL_NAME = 'TIỂU HỌC HÒA BÌNH';
const SCHOOL_YEAR = '2026-2027';
const SUBJECT_NAME = 'STEM';
const SUBJECT_CATALOG_ID = 14;

/** Chốt theo id vì trong DB có nhiều giáo viên trùng tên gọi ("Chi", "Hiền", "Khôi", "Cường"). */
const TEACHERS = {
    tien: { id: 161, name: 'Nguyễn Ngọc Mỹ Tiên' },
    kimChi: { id: 47, name: 'Vũ Thị Kim Chi' },
    khoi: { id: 213, name: 'Lê Dương Chí Khôi' },
    cuong: { id: 156, name: 'Trần Tuấn Cường' },
    hien: { id: 218, name: 'Hoàng Nguyễn Diệu Hiền' },
} as const;

type TeacherKey = keyof typeof TEACHERS;

/** Cùng khoảng hiệu lực với các TKB 2026-2027 khác đang chạy. */
const EFFECTIVE_FROM = '2026-09-07';
const EFFECTIVE_TO = '2027-05-31';

/** Tiết "4B" là tiết 4 kéo dài của buổi sáng (10:35-11:10) theo bảng giấy. */
const PERIOD_TIME = {
    morning: {
        1: ['07:30', '08:05'],
        2: ['08:10', '08:45'],
        3: ['09:20', '09:55'],
        4: ['10:00', '10:35'],
        4.5: ['10:35', '11:10'],
    },
    afternoon: {
        1: ['13:45', '14:20'],
        2: ['14:25', '15:00'],
        3: ['15:25', '16:00'],
    },
} as const;

type Session = keyof typeof PERIOD_TIME;

interface Slot {
    session: Session;
    /** 4.5 = tiết "4B" trong bảng giấy. */
    period: number;
    /** 2 = Thứ Hai … 6 = Thứ Sáu. */
    dayOfWeek: number;
    className: string;
    campus: 'CS1' | 'CS2';
    teacher: TeacherKey;
}

const SLOTS: Slot[] = [
    // ===== SÁNG — tiết 4 =====
    { session: 'morning', period: 4, dayOfWeek: 4, className: '1/4', campus: 'CS2', teacher: 'tien' },

    // ===== SÁNG — tiết 4B =====
    { session: 'morning', period: 4.5, dayOfWeek: 3, className: '1T4', campus: 'CS1', teacher: 'kimChi' },
    { session: 'morning', period: 4.5, dayOfWeek: 3, className: '4T1', campus: 'CS1', teacher: 'khoi' },
    { session: 'morning', period: 4.5, dayOfWeek: 5, className: '1T2', campus: 'CS1', teacher: 'khoi' },
    { session: 'morning', period: 4.5, dayOfWeek: 5, className: '5T1', campus: 'CS1', teacher: 'tien' },
    { session: 'morning', period: 4.5, dayOfWeek: 5, className: '5T2', campus: 'CS1', teacher: 'cuong' },
    { session: 'morning', period: 4.5, dayOfWeek: 5, className: '4/2', campus: 'CS2', teacher: 'kimChi' },
    { session: 'morning', period: 4.5, dayOfWeek: 6, className: '1/3', campus: 'CS2', teacher: 'tien' },
    { session: 'morning', period: 4.5, dayOfWeek: 6, className: '5/1', campus: 'CS2', teacher: 'kimChi' },

    // ===== CHIỀU =====
    { session: 'afternoon', period: 1, dayOfWeek: 2, className: '2/1', campus: 'CS1', teacher: 'hien' },
    { session: 'afternoon', period: 1, dayOfWeek: 3, className: '5/2', campus: 'CS2', teacher: 'kimChi' },

    { session: 'afternoon', period: 2, dayOfWeek: 2, className: '1/2', campus: 'CS1', teacher: 'hien' },
    { session: 'afternoon', period: 2, dayOfWeek: 3, className: '4T2', campus: 'CS1', teacher: 'hien' },

    { session: 'afternoon', period: 3, dayOfWeek: 2, className: '2/2', campus: 'CS2', teacher: 'tien' },
    { session: 'afternoon', period: 3, dayOfWeek: 4, className: '5/3', campus: 'CS2', teacher: 'tien' },
];

/** "1/4" → khối 1, "5T2" → khối 5. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className[0]);
    return Number.isFinite(grade) ? grade : null;
}

function sessionLabel(session: Session): string {
    return session === 'morning' ? 'sáng' : 'chiều';
}

function periodLabel(period: number): string {
    return period === 4.5 ? '4B' : String(period);
}

async function main() {
    const client = new Client(DB);
    await client.connect();

    try {
        await client.query('BEGIN');

        // ===== Trường (phải có sẵn) =====
        const school = await client.query(`SELECT id, name FROM schools WHERE id = $1`, [SCHOOL_ID]);
        if (school.rowCount === 0) {
            throw new Error(
                `Không có trường id=${SCHOOL_ID} trong bảng schools.\n` +
                `→ Nhân sự tạo trường trên UI trước (kèm địa chỉ/toạ độ/bán kính check-in), rồi chạy lại script.`,
            );
        }
        if (school.rows[0].name !== SCHOOL_NAME) {
            throw new Error(
                `Trường id=${SCHOOL_ID} tên "${school.rows[0].name}", không phải "${SCHOOL_NAME}" — id có thể đã bị dùng lại.`,
            );
        }
        const schoolId: number = SCHOOL_ID;
        console.log(`✓ Trường "${school.rows[0].name}" (id=${schoolId})`);

        // ===== Cơ sở (phải có sẵn — mỗi cơ sở cần toạ độ check-in riêng) =====
        const campusIds = new Map<string, number>();
        for (const campus of [...new Set(SLOTS.map((s) => s.campus))]) {
            const loc = await client.query(
                `SELECT id FROM school_locations WHERE school_id = $1 AND name = $2`,
                [schoolId, campus],
            );
            if (loc.rowCount === 0) {
                throw new Error(
                    `Chưa có cơ sở "${campus}" của trường id=${schoolId} trong school_locations.\n` +
                    `→ Nhân sự tạo cơ sở trên UI trước (kèm toạ độ/bán kính check-in), rồi chạy lại script.`,
                );
            }
            campusIds.set(campus, loc.rows[0].id);
            console.log(`✓ Cơ sở ${campus} (id=${loc.rows[0].id})`);
        }

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
        if (subject.rowCount! > 1) {
            throw new Error(
                `Có ${subject.rowCount} môn "${SUBJECT_NAME}" ${SCHOOL_YEAR} của trường id=${schoolId} — dọn tay trước khi chạy lại.`,
            );
        }
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
        // Tên lớp là duy nhất trong một năm học kể cả khi khác cơ sở, nên tra theo
        // (trường, tên, năm học) rồi mới chỉnh cơ sở — tránh nhân đôi lớp khi bản
        // ghi cũ được tạo thiếu school_location_id.
        const classes = [...new Map(SLOTS.map((s) => [s.className, s])).values()];
        const classIds = new Map<string, number>();
        for (const { className, campus } of classes) {
            const locationId = campusIds.get(campus)!;
            let cls = await client.query(
                `SELECT id, school_location_id FROM school_classes
                 WHERE school_id = $1 AND name = $2 AND school_year = $3`,
                [schoolId, className, SCHOOL_YEAR],
            );
            if (cls.rowCount! > 1) {
                throw new Error(
                    `Có ${cls.rowCount} lớp "${className}" ${SCHOOL_YEAR} của trường id=${schoolId} ` +
                    `(id: ${cls.rows.map((r) => r.id).join(', ')}) — dọn tay trước khi chạy lại.`,
                );
            }
            if (cls.rowCount === 0) {
                cls = await client.query(
                    `INSERT INTO school_classes (school_id, name, grade_level, school_year, school_location_id)
                     VALUES ($1, $2, $3, $4, $5) RETURNING id, school_location_id`,
                    [schoolId, className, gradeLevelOf(className), SCHOOL_YEAR, locationId],
                );
                console.log(`+ Lớp ${className} ${campus} (id=${cls.rows[0].id})`);
            } else if (cls.rows[0].school_location_id !== locationId) {
                await client.query(
                    `UPDATE school_classes SET school_location_id = $1, updated_at = now() WHERE id = $2`,
                    [locationId, cls.rows[0].id],
                );
                console.log(`~ Lớp ${className}: cơ sở ${cls.rows[0].school_location_id} → ${campus} (${locationId})`);
            }
            const classId: number = cls.rows[0].id;
            classIds.set(className, classId);
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
        // Khoá tự nhiên của một tiết là (trường, lớp, môn) — mỗi lớp đúng 1 tiết/tuần
        // theo bảng giấy, nên chạy lại sau khi đổi thứ/giờ/giáo viên thì tiết cũ được
        // sửa tại chỗ thay vì nhân đôi thành hai bản ghi cho cùng một lớp.
        let created = 0;
        let updated = 0;
        let skipped = 0;
        for (const slot of SLOTS) {
            const [startTime, endTime] = (PERIOD_TIME[slot.session] as Record<
                number,
                readonly [string, string]
            >)[slot.period];
            const classId = classIds.get(slot.className)!;
            const { id: teacherId, name: teacherName } = TEACHERS[slot.teacher];
            const note = `TKB ${SCHOOL_YEAR} — tiết ${periodLabel(slot.period)} ${sessionLabel(slot.session)} ${slot.campus}`;

            const existing = await client.query(
                `SELECT id, teacher_id, day_of_week, start_time, end_time, effective_from, effective_to
                 FROM teaching_schedules
                 WHERE school_id = $1 AND class_id = $2 AND subject_id = $3`,
                [schoolId, classId, subjectId],
            );
            if (existing.rowCount! > 1) {
                throw new Error(
                    `Có ${existing.rowCount} mẫu lịch cho lớp ${slot.className} ` +
                    `(id: ${existing.rows.map((r) => r.id).join(', ')}) — bảng giấy chỉ có 1 tiết/tuần, dọn tay trước khi chạy lại.`,
                );
            }
            if (existing.rowCount === 1) {
                const row = existing.rows[0];
                const same =
                    row.teacher_id === teacherId &&
                    row.day_of_week === slot.dayOfWeek &&
                    String(row.start_time).slice(0, 5) === startTime &&
                    String(row.end_time).slice(0, 5) === endTime;
                if (same) {
                    skipped++;
                } else {
                    await client.query(
                        `UPDATE teaching_schedules
                         SET teacher_id = $1, day_of_week = $2, start_time = $3, end_time = $4,
                             effective_from = $5, effective_to = $6, is_active = true, note = $7,
                             updated_at = now()
                         WHERE id = $8`,
                        [teacherId, slot.dayOfWeek, startTime, endTime, EFFECTIVE_FROM, EFFECTIVE_TO, note, row.id],
                    );
                    console.log(
                        `~ ${slot.className}: T${row.day_of_week} ${String(row.start_time).slice(0, 5)} gv${row.teacher_id} ` +
                        `→ T${slot.dayOfWeek} ${startTime} ${teacherName} (gv${teacherId})`,
                    );
                    updated++;
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
                    note,
                ],
            );
            created++;
        }

        // Chặn phân công bất khả thi: cùng GV, cùng thứ, khung giờ chồng nhau ở hai trường.
        const clash = await client.query(
            `SELECT te.name, a.day_of_week, a.start_time, s2.name AS school_b
             FROM teaching_schedules a
             JOIN teaching_schedules b
               ON b.teacher_id = a.teacher_id AND b.day_of_week = a.day_of_week
              AND b.id <> a.id AND b.is_active
              AND b.start_time < a.end_time AND a.start_time < b.end_time
             JOIN teachers te ON te.id = a.teacher_id
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
            `✓ Xong: ${created} mẫu lịch mới, ${updated} cập nhật, ${skipped} giữ nguyên ` +
            `(tổng ${SLOTS.length} tiết/tuần; 2 tiết CLB ROBOT không seed vì bảng giấy thiếu lớp/GV).`,
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
