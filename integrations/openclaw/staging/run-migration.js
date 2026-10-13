// Chạy ĐÚNG MỘT migration (up|down) trong một transaction trên DB mà staging-api
// đang dùng — không chạy cả lịch sử như `typeorm migration:run` (bảng `migrations`
// chỉ ghi 2 dòng, CLI sẽ cố chạy lại mọi migration cũ).
//
//   docker compose --env-file /opt/kido-recruiter/.env run --rm --no-deps -T staging-api \
//     node - dist/migrations/<file>.js up < staging/run-migration.js
const path = require('path');
const { DataSource } = require('typeorm');

async function main() {
  const [file, direction = 'up'] = process.argv.slice(2);
  if (!file || !['up', 'down'].includes(direction)) {
    throw new Error('Dùng: node - <dist/migrations/file.js> [up|down]');
  }
  const mod = require(path.resolve(file));
  const Migration = Object.values(mod).find((v) => typeof v === 'function');
  const migration = new Migration();
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await ds.initialize();
  console.log(`DB ${process.env.DB_NAME} — ${migration.name}.${direction}()`);
  const qr = ds.createQueryRunner();
  await qr.startTransaction();
  try {
    // Tuỳ chọn (guard đặt): migration cần khoá ACCESS EXCLUSIVE trên bảng đang có ghi thì
    // chờ khoá tối đa chừng này rồi rollback, thay vì xếp hàng chặn mọi truy vấn phía sau.
    const lockTimeout = process.env.MIGRATION_LOCK_TIMEOUT;
    if (lockTimeout) {
      if (!/^\d{1,5}(ms|s)$/.test(lockTimeout)) throw new Error(`MIGRATION_LOCK_TIMEOUT sai: ${lockTimeout}`);
      await qr.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
    }
    await migration[direction](qr);
    await qr.commitTransaction();
    console.log('OK — đã commit');
  } catch (error) {
    await qr.rollbackTransaction();
    console.error(`LỖI — đã rollback: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await qr.release();
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
