#!/usr/bin/env node
// Preflight G6 (P3-7.2B) — kiểm chữ ký thật của các request Zalo đang CÁCH LY bằng OA secret key, KHÔNG
// promote, KHÔNG ghi DB (transaction READ ONLY). Dùng đúng hàm parse + kiểm chữ ký của bản dựng phát hành
// (`<dist>/recruitment/channels/zalo-recruitment-event.js`) nên kết quả trùng với bước verify thật.
// Chỉ in số lượng — không nội dung, không id người gửi, không secret.
//
//   node zalo-quarantine-preflight.js --dist <dist> [--env-file <file>]…
//     cấu hình lấy từ env của tiến trình, bị ghi đè lần lượt bởi các --env-file (dotenv, không export):
//     DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME, RECRUITMENT_ZALO_APP_ID, RECRUITMENT_ZALO_OA_ID,
//     RECRUITMENT_ZALO_OA_SECRET_KEY, RECRUITMENT_ZALO_TOKEN_KEY
//   Thoát: 0 = có ≥ 1 request chữ ký khớp và không dòng nào hỏng/không giải mã được; 2 = không request nào
//   khớp (công thức/khoá sai, hoặc chưa có request thật có chữ ký) — KHÔNG cutover; 1 = lỗi.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

function arg(name) {
  const values = [];
  process.argv.forEach((a, i) => a === name && values.push(process.argv[i + 1]));
  return values;
}

const dist = path.resolve(arg('--dist')[0] || 'dist');
const dep = (name) => require(require.resolve(name, { paths: [dist, process.cwd()] }));
const dotenv = dep('dotenv');
const { Client } = dep('pg');
const event = require(path.join(dist, 'recruitment/channels/zalo-recruitment-event.js'));
const { decryptToken } = require(path.join(dist, 'recruitment/channels/zalo-token.crypto.js'));
const { decodeKey } = require(path.join(dist, 'recruitment/channels/zalo-outbound.config.js'));

const env = { ...process.env };
for (const file of arg('--env-file')) Object.assign(env, dotenv.parse(fs.readFileSync(file)));
const get = (k) => env[k];

/** Phải trùng `quarantineAad` trong recruitment-zalo-quarantine.service.ts. */
const aad = (oaId, payloadHash) => `quarantine:${oaId}:${payloadHash}`;

async function main() {
  const read = event.readRecruitmentZaloConfig(get);
  if (!('config' in read)) throw new Error(`thiếu/sai cấu hình: ${read.invalid.join(', ')}`);
  const config = read.config;
  const key = decodeKey(get('RECRUITMENT_ZALO_TOKEN_KEY')?.trim() ?? '');
  if (!key) throw new Error('thiếu/sai RECRUITMENT_ZALO_TOKEN_KEY');

  const db = new Client({
    host: get('DB_HOST'),
    port: Number(get('DB_PORT')) || 5432,
    user: get('DB_USER'),
    password: get('DB_PASSWORD'),
    database: get('DB_NAME'),
  });
  await db.connect();
  const counts = {};
  const byType = {};
  let pass = 0;
  let broken = 0;
  let oldest = null;
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    const { rows } = await db.query(
      `SELECT id, channel_account_id, payload_hash, signature, body_enc, event_type, received_at
       FROM recruitment_channel_quarantine WHERE status = 'QUARANTINED' ORDER BY id`,
    );
    for (const row of rows) {
      oldest = oldest ?? row.received_at;
      let outcome;
      try {
        const body = Buffer.from(decryptToken(key, aad(row.channel_account_id, row.payload_hash), row.body_enc), 'base64');
        if (createHash('sha256').update(body).digest('hex') !== row.payload_hash) outcome = 'INTEGRITY';
        else if (row.channel_account_id !== config.oaId) outcome = 'OA_MISMATCH';
        else {
          const parsed = event.parseZaloRecruitmentEvent(config, body, row.signature);
          outcome = parsed.ok ? 'WOULD_VERIFY' : row.signature ? parsed.code : `${parsed.code} (không có header chữ ký)`;
        }
      } catch {
        outcome = 'UNDECRYPTABLE';
      }
      counts[outcome] = (counts[outcome] ?? 0) + 1;
      const type = `${row.event_type ?? '-'}:${outcome === 'WOULD_VERIFY' ? 'khớp' : 'không khớp'}`;
      byType[type] = (byType[type] ?? 0) + 1;
      if (outcome === 'WOULD_VERIFY') pass += 1;
      if (outcome === 'INTEGRITY' || outcome === 'UNDECRYPTABLE') broken += 1;
    }
    await db.query('ROLLBACK');
  } finally {
    await db.end();
  }
  console.log(`dòng QUARANTINED: ${Object.values(counts).reduce((a, b) => a + b, 0)}${oldest ? ` (cũ nhất nhận lúc ${new Date(oldest).toISOString()})` : ''}`);
  console.log(`kết quả nếu xác minh: ${JSON.stringify(counts)}`);
  console.log(`theo loại event: ${JSON.stringify(byType)}`);
  console.log('chế độ: CHỈ ĐỌC (transaction READ ONLY, ROLLBACK) — không promote, không ghi');
  process.exitCode = pass > 0 && broken === 0 ? 0 : pass === 0 ? 2 : 1;
}

main().catch((error) => {
  console.error(`LỖI: ${error && error.message}`);
  process.exitCode = 1;
});
