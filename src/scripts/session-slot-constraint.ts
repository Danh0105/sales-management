/**
 * Ràng buộc **ở tầng dữ liệu**: một khung giờ của một ngày chỉ được có đúng
 * một lớp và một giáo viên.
 *
 * Kiểm tra trong service đã chặn các đường đi bình thường, nhưng nó chỉ đúng
 * khi mọi thao tác đều đi qua service — import thời khoá biểu, script seed,
 * hay một agent tự sinh dữ liệu thì đi thẳng xuống bảng. Unique index là chốt
 * chặn cuối, và là thứ duy nhất còn tác dụng khi hai request chạy song song.
 *
 * Cố ý **không** khai index trong entity: `synchronize: true` sẽ cố tạo index
 * ngay lúc khởi động, gặp dữ liệu trùng sẵn có là app không boot nổi — hỏng
 * production vì một ràng buộc mới thì không đáng.
 *
 *   npm run teaching:slot-check    # xem các ô lịch đang bị trùng
 *   npm run teaching:slot-apply    # tạo unique index (chỉ chạy khi đã sạch)
 */
import 'dotenv/config';
import { DataSource } from 'typeorm';
import dataSource from '../data-source';

const TEACHER_INDEX = 'UQ_teaching_sessions_teacher_slot';
const CLASS_INDEX = 'UQ_teaching_sessions_class_slot';

/** Buổi đã huỷ không chiếm chỗ nên nằm ngoài ràng buộc. */
const ACTIVE = `status <> 'CANCELLED'`;

const duplicateSql = (column: string) => `
  SELECT s.${column} AS owner_id, to_char(s.date, 'YYYY-MM-DD') AS date, s.start_time,
         count(*) AS n, array_agg(s.id ORDER BY s.id) AS ids
  FROM teaching_sessions s
  WHERE s.${column} IS NOT NULL AND ${ACTIVE}
  GROUP BY s.${column}, s.date, s.start_time
  HAVING count(*) > 1
  ORDER BY s.date
`;

async function report(ds: DataSource): Promise<number> {
  const teacherDups = await ds.query(duplicateSql('teacher_id'));
  const classDups = await ds.query(duplicateSql('class_id'));

  const show = (title: string, rows: any[]) => {
    console.log(`\n${title}: ${rows.length} ô lịch bị trùng`);
    for (const row of rows) {
      console.log(
        `  #${row.owner_id} · ${row.date} ${row.start_time}` +
          ` · ${row.n} buổi (id: ${row.ids.join(', ')})`,
      );
    }
  };

  show('Giáo viên bị xếp 2 buổi cùng giờ', teacherDups);
  show('Lớp bị xếp 2 buổi cùng giờ', classDups);

  return teacherDups.length + classDups.length;
}

async function apply(ds: DataSource) {
  await ds.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "${TEACHER_INDEX}"
    ON teaching_sessions (teacher_id, date, start_time)
    WHERE teacher_id IS NOT NULL AND ${ACTIVE}
  `);
  await ds.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "${CLASS_INDEX}"
    ON teaching_sessions (class_id, date, start_time)
    WHERE class_id IS NOT NULL AND ${ACTIVE}
  `);
  console.log(`\n✅ Đã tạo ${TEACHER_INDEX} và ${CLASS_INDEX}`);
}

async function main() {
  const ds = await dataSource.initialize();

  try {
    const total = await report(ds);

    if (!process.argv.includes('--apply')) {
      console.log('\nChạy `npm run teaching:slot-apply` để tạo unique index.');
      return;
    }

    if (total > 0) {
      // Huỷ hay xoá buổi nào là quyết định nghiệp vụ (buổi nào mới đúng lịch),
      // script không đoán hộ.
      console.error(
        `\n❌ Còn ${total} ô lịch trùng. Xử lý hết rồi mới tạo được index — ` +
          'huỷ (status = CANCELLED) hoặc xoá buổi thừa ở màn Thời khoá biểu.',
      );
      process.exitCode = 1;
      return;
    }

    await apply(ds);
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
