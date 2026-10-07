// Kiểm schema DB staging khớp entity TypeORM của image (sau migration viết tay):
// liệt kê câu SQL mà `synchronize` SẼ chạy — chỉ in, KHÔNG chạy. Lọc theo regex
// tên bảng/enum (mặc định: recruitment). Exit 1 nếu còn chênh lệch.
//
//   docker compose --env-file /opt/kido-recruiter/.env run --rm --no-deps -T staging-api \
//     node - '^recruitment_channel_events' < staging/schema-diff.js
const path = require('path');
const fs = require('fs');
const { DataSource } = require('typeorm');

function entityFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entityFiles(full);
    return entry.name.endsWith('.entity.js') ? [full] : [];
  });
}

async function main() {
  const filter = new RegExp(process.argv[2] || 'recruitment', 'i');
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    entities: entityFiles(path.resolve('dist')),
    synchronize: false,
  });
  await ds.initialize();
  try {
    const tables = ds.entityMetadatas.filter((m) => filter.test(m.tableName));
    const sql = await ds.driver.createSchemaBuilder().log();
    const diff = sql.upQueries.map((q) => q.query).filter((q) => filter.test(q));
    console.log(
      `DB ${process.env.DB_NAME}: entity khớp lọc=${tables.map((m) => m.tableName).join(',') || '(không có)'}`,
    );
    console.log(`chênh lệch (lọc ${filter}): ${diff.length}`);
    for (const q of diff) console.log('  DIFF>', q);
    if (!tables.length || diff.length) process.exitCode = 1;
  } finally {
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
