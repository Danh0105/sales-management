/**
 * Đồng bộ bảng **Chấm công** theo bảng **Phân lịch** cho dữ liệu đã lệch sẵn.
 *
 * Trước khi có phần đồng bộ trong `TeachingScheduleService.update`, sửa mẫu
 * lịch không đẩy gì xuống buổi dạy: Nhân sự chuyển toàn bộ tiết của một giáo
 * viên sang người khác thì mẫu lịch đổi tên, còn buổi dạy vẫn đứng tên người
 * cũ — người mới bấm check-in bị chặn "Bạn không phải giáo viên của buổi dạy
 * này". Script này dọn phần đã lệch từ trước; từ nay các lần sửa mới tự đồng bộ.
 *
 * **Chỉ đụng vào buổi từ hôm nay trở đi.** Tiết đã qua ngày là lịch sử: người
 * đứng lớp hôm đó là người đã dạy thật, ghi đè thành người mới là ghi sai công.
 * Buổi đã chấm công / đã check-in cũng không đụng, kể cả ở tương lai.
 *
 *   npm run teaching:resync                            # xem lệch những gì, không ghi
 *   npm run teaching:resync -- --apply                 # đồng bộ tất cả
 *   npm run teaching:resync -- --only-teacher --apply  # chỉ gán lại giáo viên
 */
import 'dotenv/config';
import { DataSource } from 'typeorm';
import dataSource from '../data-source';

/** Buổi còn được phép sửa: chưa ai chấm công, chưa check-in, chưa báo giảng. */
const EDITABLE = `
  ss.status = 'SCHEDULED'
  AND ss.checkin_at IS NULL
  AND ss.checkout_at IS NULL
  AND ss.lesson_submitted_at IS NULL
`;

/**
 * Buổi đang đứng tên sai người. `IS NOT NULL` vì buổi `OPEN` (chưa ai nhận)
 * không được tự gán — xem `OPEN_SQL`.
 */
const TEACHER_DRIFT = `
  ss.teacher_id IS NOT NULL AND ss.teacher_id IS DISTINCT FROM s.teacher_id
`;

/**
 * Chỉ so các cột buổi dạy **chép từ** mẫu lịch. Đơn giá và phụ cấp xăng cố ý
 * nằm ngoài: chúng được chốt theo giáo viên tại thời điểm sinh buổi, tính lại
 * ở đây sẽ đụng vào tiền của những buổi không hề lệch phân công.
 *
 * `--only-teacher` thu hẹp về đúng cột giáo viên: đó là thứ chặn check-in, sửa
 * được ngay mà không đụng tới phần lệch giờ còn đang chờ Nhân sự xác nhận là
 * sửa có chủ đích hay sửa nhầm.
 */
const driftCondition = (onlyTeacher: boolean) =>
  onlyTeacher
    ? TEACHER_DRIFT
    : `
      ${TEACHER_DRIFT}
      OR ss.school_id IS DISTINCT FROM s.school_id
      OR ss.school_location_id IS DISTINCT FROM s.school_location_id
      OR ss.class_id IS DISTINCT FROM s.class_id
      OR ss.subject_id IS DISTINCT FROM s.subject_id
      OR ss.start_time IS DISTINCT FROM s.start_time
      OR ss.end_time IS DISTINCT FROM s.end_time
      OR ss.periods IS DISTINCT FROM COALESCE(s.periods, 1)
    `;

const driftSql = (onlyTeacher: boolean) => `
  SELECT ss.id, to_char(ss.date, 'YYYY-MM-DD') AS date,
         ss.teacher_id AS session_teacher, s.teacher_id AS schedule_teacher,
         old_t.name AS old_name, new_t.name AS new_name
  FROM teaching_sessions ss
  JOIN teaching_schedules s ON s.id = ss.schedule_id
  LEFT JOIN teachers old_t ON old_t.id = ss.teacher_id
  LEFT JOIN teachers new_t ON new_t.id = s.teacher_id
  WHERE ss.date >= CURRENT_DATE
    AND ${EDITABLE}
    AND (${driftCondition(onlyTeacher)})
  ORDER BY ss.date
`;

/**
 * Đổi giáo viên là giao lịch mới trên thực tế nên phải xoá dấu vết từ chối của
 * người cũ và bắt xác nhận lại — giống hệt luồng sửa lịch trong service.
 */
const applySql = (onlyTeacher: boolean) => `
  UPDATE teaching_sessions ss SET
    teacher_id = s.teacher_id,
    assignment_status = 'ASSIGNED',
    recommended_teacher_id = s.teacher_id,
    -- Người mới nhận lịch thì mọi dấu vết từ chối của người cũ phải sạch,
    -- nếu không màn Phân công vẫn hiện "đã từ chối" cho một người đã đổi.
    declined_teacher_id = NULL,
    declined_at = NULL,
    decline_reason = NULL,
    confirmation_status = 'PENDING',
    confirmed_at = NULL,
    rejection_reason = NULL,
    ${
      onlyTeacher
        ? ''
        : `school_id = s.school_id,
    school_location_id = s.school_location_id,
    class_id = s.class_id,
    subject_id = s.subject_id,
    start_time = s.start_time,
    end_time = s.end_time,
    periods = COALESCE(s.periods, 1),`
    }
    updated_at = NOW()
  FROM teaching_schedules s
  WHERE s.id = ss.schedule_id
    AND ss.date >= CURRENT_DATE
    AND ${EDITABLE}
    AND (${TEACHER_DRIFT})
`;

/**
 * Lệch nhưng KHÔNG phải lệch giáo viên (chỉ sai giờ/môn) — chạy riêng, vì các
 * cột `confirmation_*` ở trên không được đụng tới: sửa giờ không phải giao
 * lịch mới, bắt giáo viên xác nhận lại là làm phiền vô cớ.
 */
const APPLY_FIELDS_SQL = `
  UPDATE teaching_sessions ss SET
    school_id = s.school_id,
    school_location_id = s.school_location_id,
    class_id = s.class_id,
    subject_id = s.subject_id,
    start_time = s.start_time,
    end_time = s.end_time,
    periods = COALESCE(s.periods, 1),
    updated_at = NOW()
  FROM teaching_schedules s
  WHERE s.id = ss.schedule_id
    AND ss.date >= CURRENT_DATE
    AND ${EDITABLE}
    AND NOT (${TEACHER_DRIFT})
    AND (
      ss.school_id IS DISTINCT FROM s.school_id
      OR ss.school_location_id IS DISTINCT FROM s.school_location_id
      OR ss.class_id IS DISTINCT FROM s.class_id
      OR ss.subject_id IS DISTINCT FROM s.subject_id
      OR ss.start_time IS DISTINCT FROM s.start_time
      OR ss.end_time IS DISTINCT FROM s.end_time
      OR ss.periods IS DISTINCT FROM COALESCE(s.periods, 1)
    )
`;

/**
 * Buổi **chưa có giáo viên** (`OPEN`) mà mẫu lịch thì có.
 *
 * Cố ý không tự gán: buổi về `OPEN` là do giáo viên đã từ chối, gán lại cho
 * đúng người vừa từ chối là xoá mất quyết định đó. Nêu ra để Nhân sự tự chọn.
 */
const OPEN_SQL = `
  SELECT count(*) AS n
  FROM teaching_sessions ss
  JOIN teaching_schedules s ON s.id = ss.schedule_id
  WHERE ss.date >= CURRENT_DATE AND ${EDITABLE} AND ss.teacher_id IS NULL
`;

/** Buổi lệch nhưng KHÔNG được sửa — nêu ra để Nhân sự xử lý tay. */
const LOCKED_SQL = `
  SELECT count(*) AS n
  FROM teaching_sessions ss
  JOIN teaching_schedules s ON s.id = ss.schedule_id
  WHERE ss.date >= CURRENT_DATE
    AND NOT (${EDITABLE})
    AND ss.teacher_id IS DISTINCT FROM s.teacher_id
`;

async function main() {
  const apply = process.argv.includes('--apply');
  const onlyTeacher = process.argv.includes('--only-teacher');
  const ds: DataSource = await dataSource.initialize();

  try {
    const rows: any[] = await ds.query(driftSql(onlyTeacher));
    const [{ n: locked }] = await ds.query(LOCKED_SQL);
    const [{ n: open }] = await ds.query(OPEN_SQL);

    if (!rows.length) {
      console.log('Bảng chấm công đã khớp bảng phân lịch, không có gì để sửa.');
    } else {
      // Gộp theo cặp người cũ → người mới: 800 dòng buổi thì không ai đọc nổi.
      type Group = { label: string; n: number; from: string; to: string };
      const groups = new Map<string, Group>();

      for (const row of rows) {
        const key = `${row.session_teacher}->${row.schedule_teacher}`;
        const group = groups.get(key) ?? {
          label:
            row.session_teacher === row.schedule_teacher
              ? 'lệch giờ/môn/lớp (cùng giáo viên)'
              : `${row.old_name ?? row.session_teacher} → ${row.new_name ?? row.schedule_teacher}`,
          n: 0,
          from: row.date,
          to: row.date,
        };
        group.n += 1;
        if (row.date < group.from) group.from = row.date;
        if (row.date > group.to) group.to = row.date;
        groups.set(key, group);
      }

      console.log(
        `\n${rows.length} buổi từ hôm nay trở đi đang lệch` +
          (onlyTeacher ? ' giáo viên (--only-teacher):' : ':'),
      );
      for (const group of groups.values()) {
        console.log(`  ${group.label}: ${group.n} buổi (${group.from} → ${group.to})`);
      }
    }

    if (Number(locked) > 0) {
      console.log(
        `\n⚠ ${locked} buổi lệch giáo viên nhưng đã chấm công / đã check-in — ` +
          'không tự sửa, Nhân sự phải xử lý tay.',
      );
    }

    if (Number(open) > 0) {
      console.log(
        `\n⚠ ${open} buổi chưa có giáo viên (OPEN) — không tự gán, ` +
          'Nhân sự chọn người ở màn Phân công.',
      );
    }

    if (!apply) {
      console.log('\nXem trước, chưa ghi gì. Chạy lại với --apply để cập nhật.');
      return;
    }

    const teacherFixed = (await ds.query(applySql(onlyTeacher)))[1] ?? 0;
    console.log(`\nĐã gán lại giáo viên cho ${teacherFixed} buổi.`);

    if (!onlyTeacher) {
      const fieldsFixed = (await ds.query(APPLY_FIELDS_SQL))[1] ?? 0;
      console.log(`Đã đồng bộ giờ/môn/lớp cho ${fieldsFixed} buổi.`);
    }
  } finally {
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
