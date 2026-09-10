/**
 * Seed TKB KNS — Tiểu học Võ Văn Tần, năm học 2025-2026.
 *
 * Bảng TKB giấy gồm 3 tuần, chỉ dạy buổi CHIỀU, một mình cô Phan Thị Anh Thư:
 *   - 04/05–09/05 và 11/05–16/05: hai tuần giống hệt nhau (Thứ 3 → Thứ 6).
 *   - 18/05–23/05: giữ nguyên toàn bộ tiết của hai tuần trước, thêm cột Thứ 2,
 *     cột Thứ 7 (dạy bù) và 4 tiết chen vào Thứ 3/Thứ 4/Thứ 5.
 *
 * Vì tuần 3 là tập cha của tuần 1-2 nên lịch được tách làm hai nhóm mẫu:
 *   - BASE_SLOTS  : hiệu lực 04/05/2026 → 23/05/2026 (chạy cả 3 tuần).
 *   - WEEK3_SLOTS : hiệu lực 18/05/2026 → 23/05/2026 (chỉ tuần cuối).
 *
 * Tên lớp trong bảng viết lẫn "3.4" và "3/2"; ở đây chuẩn hoá hết về dạng
 * "3/4" cho khớp quy ước lớp đã có sẵn của trường trong DB.
 *
 * Trường không có cột cơ sở nên lịch để school_location_id = NULL (giống các
 * lớp 1/1–1/3 đang có). Nếu sau này tách cơ sở thì cập nhật lại.
 *
 * Chạy lại được nhiều lần: mọi INSERT đều tra trước theo khoá tự nhiên (lớp
 * theo school+name+year, lịch theo teacher+class+subject+day+start_time+
 * effective_from) nên không sinh bản ghi trùng.
 *
 * Chạy: npm run seed:tkb-vo-van-tan
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

/**
 * Có 2 trường trùng tên "TIỂU HỌC VÕ VĂN TẦN" (id 527 và 543). Bản 527 là bản
 * đang dùng thật (đã có lớp, đã có môn KNS 2025-2026) nên khoá cứng theo id để
 * seed không vớ nhầm bản trống.
 */
const SCHOOL_ID = 527;
const SCHOOL_NAME = 'TIỂU HỌC VÕ VĂN TẦN';
const SCHOOL_YEAR = '2025-2026';
/** Môn KNS 2025-2026 của trường đã có sẵn trong DB dưới tên "KỸ NĂNG SỐNG". */
const SUBJECT_ID = 778;

const TEACHER_ID = 25;
const TEACHER_NAME = 'PHAN THỊ ANH THƯ';

/** Khung giờ từng tiết chiều, đúng cột "THỜI GIAN" của bảng TKB. */
const PERIOD_TIME: Record<number, [string, string]> = {
    1: ['13:00', '13:35'],
    2: ['13:40', '14:15'],
    3: ['14:35', '15:10'],
    4: ['15:15', '15:50'],
    5: ['15:55', '16:30'],
    6: ['16:35', '17:10'],
};

interface Slot {
    /** 2 = Thứ Hai … 7 = Thứ Bảy. */
    dayOfWeek: number;
    period: number;
    className: string;
}

/** Tiết có ở cả ba tuần (bảng tuần 04/05 và 11/05, được tuần 18/05 giữ nguyên). */
const BASE_FROM = '2026-05-04';
const BASE_TO = '2026-05-23';
const BASE_SLOTS: Slot[] = [
    // ===== THỨ 3 =====
    { dayOfWeek: 3, period: 2, className: '2/1' },
    { dayOfWeek: 3, period: 3, className: '2/8' },
    { dayOfWeek: 3, period: 4, className: '2/7' },
    { dayOfWeek: 3, period: 5, className: '2/9' },
    { dayOfWeek: 3, period: 6, className: '2/2' },

    // ===== THỨ 4 =====
    { dayOfWeek: 4, period: 1, className: '3/4' },
    { dayOfWeek: 4, period: 2, className: '3/5' },
    { dayOfWeek: 4, period: 3, className: '3/7' },
    { dayOfWeek: 4, period: 4, className: '2/3' },

    // ===== THỨ 5 =====
    { dayOfWeek: 5, period: 3, className: '3/8' },
    { dayOfWeek: 5, period: 4, className: '3/6' },
    { dayOfWeek: 5, period: 5, className: '3/9' },

    // ===== THỨ 6 =====
    { dayOfWeek: 6, period: 1, className: '3/3' },
    { dayOfWeek: 6, period: 2, className: '3/2' },
    { dayOfWeek: 6, period: 3, className: '3/1' },
    { dayOfWeek: 6, period: 4, className: '2/6' },
    { dayOfWeek: 6, period: 5, className: '2/5' },
    { dayOfWeek: 6, period: 6, className: '2/4' },
];

/** Tiết chỉ có ở tuần 18/05–23/05. */
const WEEK3_FROM = '2026-05-18';
const WEEK3_TO = '2026-05-23';
const WEEK3_SLOTS: Slot[] = [
    // ===== THỨ 2 (tuần 1-2 không có cột này) =====
    { dayOfWeek: 2, period: 1, className: '3/3' },
    { dayOfWeek: 2, period: 2, className: '3/1' },
    { dayOfWeek: 2, period: 3, className: '3/1' }, // 2 tiết liền của 3/1
    { dayOfWeek: 2, period: 4, className: '3/2' },

    // ===== Tiết chen thêm vào các ngày đã có =====
    { dayOfWeek: 3, period: 1, className: '2/8' }, // 2/8 học 2 tiết rời trong ngày
    { dayOfWeek: 4, period: 5, className: '2/5' },
    { dayOfWeek: 5, period: 1, className: '3/9' }, // 3/9 học 2 tiết rời trong ngày
    { dayOfWeek: 5, period: 2, className: '3/4' },

    // ===== THỨ 7 — dạy bù =====
    { dayOfWeek: 7, period: 1, className: '3/2' },
    { dayOfWeek: 7, period: 2, className: '3/2' }, // 2 tiết liền của 3/2
    { dayOfWeek: 7, period: 3, className: '3/3' },
    { dayOfWeek: 7, period: 4, className: '3/3' }, // 2 tiết liền của 3/3
    { dayOfWeek: 7, period: 5, className: '3/6' },
];

const GROUPS = [
    { label: 'tuần 04/05–23/05', from: BASE_FROM, to: BASE_TO, slots: BASE_SLOTS },
    { label: 'riêng tuần 18/05–23/05', from: WEEK3_FROM, to: WEEK3_TO, slots: WEEK3_SLOTS },
];

/** "3/4" → khối 3. */
function gradeLevelOf(className: string): number | null {
    const grade = Number(className.split('/')[0]);
    return Number.isFinite(grade) ? grade : null;
}

const DAY_LABEL: Record<number, string> = {
    2: 'Thứ 2', 3: 'Thứ 3', 4: 'Thứ 4', 5: 'Thứ 5', 6: 'Thứ 6', 7: 'Thứ 7 (dạy bù)',
};

async function main() {
    const client = new Client(DB);
    await client.connect();

    try {
        await client.query('BEGIN');

        // ===== Trường / giáo viên / môn: chỉ kiểm tra, không tạo mới =====
        const school = await client.query(`SELECT name FROM schools WHERE id = $1`, [SCHOOL_ID]);
        if (school.rowCount === 0 || school.rows[0].name !== SCHOOL_NAME) {
            throw new Error(`school id=${SCHOOL_ID} không phải "${SCHOOL_NAME}"`);
        }
        console.log(`✓ Trường "${SCHOOL_NAME}" (id=${SCHOOL_ID})`);

        const teacher = await client.query(`SELECT name FROM teachers WHERE id = $1`, [TEACHER_ID]);
        if (teacher.rowCount === 0 || teacher.rows[0].name !== TEACHER_NAME) {
            throw new Error(`teacher id=${TEACHER_ID} không phải "${TEACHER_NAME}"`);
        }
        console.log(`✓ Giáo viên "${TEACHER_NAME}" (id=${TEACHER_ID})`);

        const subject = await client.query(
            `SELECT name FROM subjects WHERE id = $1 AND school_id = $2 AND school_year = $3`,
            [SUBJECT_ID, SCHOOL_ID, SCHOOL_YEAR],
        );
        if (subject.rowCount === 0) {
            throw new Error(`Không thấy môn id=${SUBJECT_ID} của trường ${SCHOOL_ID} năm ${SCHOOL_YEAR}`);
        }
        console.log(`✓ Môn "${subject.rows[0].name}" ${SCHOOL_YEAR} (id=${SUBJECT_ID})`);

        // ===== Lớp học =====
        const allSlots = GROUPS.flatMap((g) => g.slots);
        const classNames = [...new Set(allSlots.map((s) => s.className))].sort();
        const classIds = new Map<string, number>();
        for (const name of classNames) {
            let cls = await client.query(
                `SELECT id FROM school_classes
                 WHERE school_id = $1 AND name = $2 AND school_year = $3`,
                [SCHOOL_ID, name, SCHOOL_YEAR],
            );
            if (cls.rowCount === 0) {
                cls = await client.query(
                    `INSERT INTO school_classes (school_id, name, grade_level, school_year)
                     VALUES ($1, $2, $3, $4) RETURNING id`,
                    [SCHOOL_ID, name, gradeLevelOf(name), SCHOOL_YEAR],
                );
                console.log(`+ Lớp ${name} (id=${cls.rows[0].id})`);
            }
            const classId: number = cls.rows[0].id;
            classIds.set(name, classId);

            await client.query(
                `INSERT INTO school_class_subjects (class_id, subject_id)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [classId, SUBJECT_ID],
            );
        }
        await client.query(`UPDATE subjects SET class_count = $1 WHERE id = $2`, [
            classNames.length,
            SUBJECT_ID,
        ]);

        // ===== Mẫu lịch =====
        let created = 0;
        let skipped = 0;
        for (const group of GROUPS) {
            for (const slot of group.slots) {
                const [startTime, endTime] = PERIOD_TIME[slot.period];
                const classId = classIds.get(slot.className)!;

                const existing = await client.query(
                    `SELECT id FROM teaching_schedules
                     WHERE teacher_id = $1 AND class_id = $2 AND subject_id = $3
                       AND day_of_week = $4 AND start_time = $5 AND effective_from = $6`,
                    [TEACHER_ID, classId, SUBJECT_ID, slot.dayOfWeek, startTime, group.from],
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
                        SCHOOL_ID,
                        classId,
                        SUBJECT_ID,
                        slot.dayOfWeek,
                        startTime,
                        endTime,
                        group.from,
                        group.to,
                        `TKB KNS ${SCHOOL_YEAR} — ${DAY_LABEL[slot.dayOfWeek]}, tiết ${slot.period} chiều (${group.label})`,
                    ],
                );
                created++;
            }
        }

        await client.query('COMMIT');
        console.log(
            `✓ Xong: ${created} mẫu lịch mới, ${skipped} đã có sẵn ` +
                `(${BASE_SLOTS.length} tiết chạy cả 3 tuần + ${WEEK3_SLOTS.length} tiết riêng tuần cuối).`,
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
