import { join } from 'path';
import { DataSource } from 'typeorm';

/**
 * DataSource CHỈ dùng để chạy migration HR — tách hẳn khỏi `src/data-source.ts`.
 *
 * - Không có entity: migration HR là SQL viết tay.
 * - Bảng theo dõi là `hr.migrations`, không đụng `public.migrations` của luồng cũ.
 * - Không có thông số kết nối mặc định: `sales_db` trên server là DB dùng chung
 *   của cả prod lẫn dev (xem `utils/is-cron-leader.ts`), nên không được phép
 *   "lỡ tay" trỏ vào đó chỉ vì quên cấu hình.
 * - `lock_timeout` ngắn để một FK tới `public.employee` không treo các request
 *   đang chạy nếu bảng đó đang bị khoá.
 * - `readOnly` (chế độ xem trước): chính PostgreSQL từ chối mọi lệnh ghi của
 *   session, không chỉ dựa vào việc code "không gọi lệnh ghi".
 */
export function createHrMigrationDataSource(
  url: string,
  { readOnly }: { readOnly: boolean },
): DataSource {
  // Chạy bằng ts-node thì đọc `.ts`; chạy từ `dist/` thì đọc `.js`
  // (không dùng `*.{ts,js}` vì `dist/` còn chứa `.d.ts`).
  const extension = __filename.endsWith('.ts') ? 'ts' : 'js';

  return new DataSource({
    type: 'postgres',
    url,
    schema: 'hr',
    entities: [],
    synchronize: false,
    migrationsRun: false,
    // Extension ảnh hưởng toàn DB — chỉ được cài qua migration CAUTION riêng.
    installExtensions: false,
    migrationsTableName: 'migrations',
    migrationsTransactionMode: 'each',
    migrations: [join(__dirname, '..', 'migrations', `*.${extension}`)],
    extra: {
      options:
        '-c lock_timeout=5000 -c statement_timeout=60000' +
        (readOnly ? ' -c default_transaction_read_only=on' : ''),
      max: 2,
    },
  });
}
