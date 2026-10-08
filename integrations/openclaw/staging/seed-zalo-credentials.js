// Nạp token OA tuyển dụng GIẢ (lấy từ staging/fake-zalo.js) vào
// recruitment_zalo_credentials — mã hoá bằng đúng code của app (dist), khoá
// RECRUITMENT_ZALO_TOKEN_KEY trong env container. Token không bao giờ được in ra.
//
//   docker compose ... exec -T staging-api node - < staging/seed-zalo-credentials.js
const path = require('path');
const { DataSource } = require('typeorm');
const { encryptToken } = require(path.resolve('dist/recruitment/channels/zalo-token.crypto.js'));

async function main() {
  const oaId = process.env.RECRUITMENT_ZALO_OA_ID;
  const raw = process.env.RECRUITMENT_ZALO_TOKEN_KEY || '';
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (!oaId || key.length !== 32) throw new Error('thiếu RECRUITMENT_ZALO_OA_ID / RECRUITMENT_ZALO_TOKEN_KEY');
  const seed = await (await fetch(process.env.FAKE_ZALO_ADMIN || 'http://localhost:3199/__seed')).json();
  if (!seed.access_token || !seed.refresh_token) throw new Error('Zalo giả không trả token');

  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await ds.initialize();
  try {
    const [row] = await ds.query(
      `INSERT INTO recruitment_zalo_credentials (oa_id, access_token_enc, refresh_token_enc, access_expires_at)
       VALUES ($1, $2, $3, now() + $4::int * interval '1 second')
       ON CONFLICT (oa_id) DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc, access_expires_at = EXCLUDED.access_expires_at,
         version = recruitment_zalo_credentials.version + 1, updated_at = now()
       RETURNING version`,
      [oaId, encryptToken(key, oaId, seed.access_token), encryptToken(key, oaId, seed.refresh_token), seed.expires_in],
    );
    console.log(`credential OA ${oaId}: version ${row.version}`);
  } finally {
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
