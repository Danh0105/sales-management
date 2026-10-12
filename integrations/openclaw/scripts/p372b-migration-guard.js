#!/usr/bin/env node
// P3-7.2B G3 — chốt chặn migration production. Bọc NGOÀI `staging/run-migration.js` (không sửa runner):
//  - đúng 8 migration, đúng thứ tự, đúng sha256 bản biên dịch (danh sách cố định bên dưới);
//  - trạng thái DB đọc bằng dấu hiệu của từng migration (bảng/cột/giá trị enum) — chỉ cho chạy khi CẢ 8 đều
//    chưa áp dụng; áp dụng dở dang / không liên tục → từ chối;
//  - chạy MỘT lần: khoá advisory phiên (pg_try_advisory_lock) suốt lần chạy + file trạng thái "completed" trong
//    --state-dir; lần sau từ chối;
//  - mỗi migration: dấu hiệu phải vắng trước, có sau; lỗi → dừng ngay (runner đã rollback migration đó);
//  - trước/sau: số dòng các bảng `recruitment_*` có sẵn (bảng migration đụng tới; production đang không ghi
//    vào đó) — phải không đổi. Bảng khác vẫn nhận ghi từ ứng dụng đang chạy nên không đem so.
//
//   node p372b-migration-guard.js check|run --dist <release>/dist --runner <run-migration.js>
//        --credentials <env 600 có SALES_MIGRATOR_PASSWORD> --state-dir <thư mục 700>
//        [--db-host 127.0.0.1] [--db-port 5432] [--db-name sales_db] [--db-user sales_migrator]
//   check = chỉ đọc. In tên + trạng thái, không in mật khẩu.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');

const MIGRATIONS = [
  ['1791900000000-add-recruitment-candidate-zalo-oa', '037d67c73032f3f6', `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'recruitment_candidates' AND column_name = 'zalo_oa_id')`],
  ['1792000000000-create-recruitment-channel-events', 'fcd79d81e5343c40', `SELECT to_regclass('public.recruitment_channel_events') IS NOT NULL`],
  ['1792100000000-add-recruitment-channel-worker', 'b00ecc6bf68a9bb3', `SELECT to_regclass('public.recruitment_channel_outbox') IS NOT NULL`],
  ['1792200000000-add-recruitment-zalo-outbound', '6bbc1ed598c6f3e7', `SELECT to_regclass('public.recruitment_zalo_credentials') IS NOT NULL`],
  ['1792300000000-add-recruitment-conversation-control', 'a013785bdead091e', `SELECT to_regclass('public.recruitment_hr_alerts') IS NOT NULL`],
  ['1792400000000-add-recruitment-event-ai-control-version', '4e3845aa1bf55b93', `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'recruitment_channel_events' AND column_name = 'ai_control_version')`],
  ['1792500000000-add-recruitment-outbox-suppressed', '18917d26012766b0', `SELECT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'recruitment_channel_outbox_status_enum' AND e.enumlabel = 'SUPPRESSED')`],
  ['1792600000000-add-recruitment-webhook-quarantine', '96471b9cb40d6b62', `SELECT to_regclass('public.recruitment_channel_quarantine') IS NOT NULL`],
];
const LOCK_KEY = 'p372b-migration-guard';

const argv = process.argv.slice(2);
const mode = argv[0];
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const dist = path.resolve(opt('--dist', 'dist'));
const runner = path.resolve(opt('--runner', 'integrations/openclaw/staging/run-migration.js'));
const stateDir = opt('--state-dir');
const dep = (name) => require(require.resolve(name, { paths: [dist, process.cwd(), path.dirname(runner)] }));

function fail(message, code = 1) {
  console.error(`DỪNG: ${message}`);
  process.exit(code);
}

async function main() {
  if (!['check', 'run'].includes(mode)) fail('dùng: check | run');
  if (!stateDir) fail('thiếu --state-dir');
  const credFile = opt('--credentials');
  if (!credFile) fail('thiếu --credentials');
  const credMode = fs.statSync(credFile).mode & 0o077;
  if (credMode) fail(`${credFile} phải quyền 600`);
  const password = (dep('dotenv').parse(fs.readFileSync(credFile)).SALES_MIGRATOR_PASSWORD || '').trim();
  if (!password) fail('thiếu SALES_MIGRATOR_PASSWORD');
  const db = {
    DB_HOST: opt('--db-host', '127.0.0.1'),
    DB_PORT: opt('--db-port', '5432'),
    DB_NAME: opt('--db-name', 'sales_db'),
    DB_USER: opt('--db-user', 'sales_migrator'),
    DB_PASSWORD: password,
  };

  // 1. Đúng 8 file, đúng hash.
  console.log(`== 1. Bản biên dịch (${dist}/migrations)`);
  let hashOk = true;
  for (const [name, expected] of MIGRATIONS) {
    const file = path.join(dist, 'migrations', `${name}.js`);
    const actual = fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16) : 'THIẾU';
    const ok = actual === expected;
    hashOk &&= ok;
    console.log(`  ${ok ? '✓' : '✗'} ${name}.js ${actual}${ok ? '' : ` (mong đợi ${expected})`}`);
  }
  if (!hashOk) fail('bản biên dịch không đúng danh sách đã duyệt — không chạy');

  // 2. Trạng thái DB.
  const { Client } = dep('pg');
  const client = new Client({ host: db.DB_HOST, port: Number(db.DB_PORT), database: db.DB_NAME, user: db.DB_USER, password: db.DB_PASSWORD });
  await client.connect();
  const marker = async (sql) => Object.values((await client.query(sql)).rows[0])[0] === true;
  const states = [];
  for (const [name, , sql] of MIGRATIONS) states.push(await marker(sql));
  const applied = states.filter(Boolean).length;
  const prefix = states.every((s, i) => s === i < applied);
  console.log(`== 2. Trạng thái DB ${db.DB_NAME}: ${states.map((s, i) => `${MIGRATIONS[i][0].slice(0, 13)}=${s ? 'đã áp dụng' : 'chưa'}`).join(' · ')}`);
  if (!prefix) fail('trạng thái không liên tục (dấu hiệu lộn xộn) — điều tra tay, không chạy', 3);

  const counts = async () => {
    const tables = (await client.query(`SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND relname LIKE 'recruitment\\_%' ORDER BY relname`)).rows.map((r) => r.relname);
    const result = {};
    for (const t of tables) result[t] = Number((await client.query(`SELECT count(*) AS n FROM public."${t}"`)).rows[0].n);
    return result;
  };
  const doneFile = path.join(stateDir, 'completed.json');
  if (mode === 'check') {
    console.log(applied === 0 ? 'KẾT QUẢ check: cả 8 chưa áp dụng — sẵn sàng chạy' : applied === MIGRATIONS.length ? 'KẾT QUẢ check: cả 8 ĐÃ áp dụng — không có gì để chạy' : `KẾT QUẢ check: áp dụng dở dang (${applied}/8) — KHÔNG chạy, điều tra`);
    if (fs.existsSync(doneFile)) console.log(`(có ${doneFile} — guard đã chạy xong trước đây)`);
    await client.end();
    process.exit(applied === 0 ? 0 : applied === MIGRATIONS.length ? 4 : 3);
  }

  // 3. run — chỉ một lần, chỉ khi cả 8 chưa áp dụng.
  if (fs.existsSync(doneFile)) fail(`đã chạy xong trước đây (${doneFile}) — không chạy lại`, 4);
  if (applied !== 0) fail(applied === MIGRATIONS.length ? 'cả 8 đã áp dụng — không chạy lại' : `áp dụng dở dang (${applied}/8) — không chạy`, applied === MIGRATIONS.length ? 4 : 3);
  const lock = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LOCK_KEY])).rows[0].ok;
  if (!lock) fail('một lần chạy guard khác đang giữ khoá — không chạy song song', 5);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const before = await counts();
  const log = { startedAt: new Date().toISOString(), db: db.DB_NAME, user: db.DB_USER, dist, steps: [] };
  console.log(`== 3. Chạy (${Object.keys(before).length} bảng recruitment_* có sẵn, ${Object.values(before).reduce((a, b) => a + b, 0)} dòng)`);
  for (let i = 0; i < MIGRATIONS.length; i += 1) {
    const [name, hash, sql] = MIGRATIONS[i];
    if (await marker(sql)) fail(`${name}: dấu hiệu đã có trước khi chạy — dừng`, 3);
    const t0 = Date.now();
    const res = spawnSync(process.execPath, ['-', path.join(dist, 'migrations', `${name}.js`), 'up'], {
      input: fs.readFileSync(runner),
      env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH ?? '', ...db },
      cwd: path.dirname(dist),
      encoding: 'utf8',
    });
    const ok = res.status === 0 && /OK/.test(res.stdout) && (await marker(sql));
    const step = { name, hash, ms: Date.now() - t0, ok };
    log.steps.push(step);
    console.log(`  ${ok ? '✓' : '✗'} ${name} (${step.ms} ms)${ok ? '' : ` — ${(res.stderr || res.stdout).split('\n').find((l) => /LỖI|Error/.test(l)) ?? 'lỗi'}`}`);
    if (!ok) {
      log.failedAt = name;
      fs.writeFileSync(path.join(stateDir, `failed-${Date.now()}.json`), JSON.stringify(log, null, 2), { mode: 0o600 });
      fail(`dừng ở ${name} — migration đó đã rollback; ${i} migration trước đã áp dụng (xem runbook rollback)`, 6);
    }
  }
  const after = await counts();
  const changed = Object.keys(before).filter((t) => before[t] !== after[t]);
  const added = Object.keys(after).filter((t) => !(t in before));
  log.finishedAt = new Date().toISOString();
  log.rowCountsUnchanged = changed.length === 0;
  log.changedTables = changed;
  log.newTables = added;
  console.log(`== 4. Sau: bảng recruitment_* có sẵn đổi số dòng: ${changed.length ? changed.join(', ') : '0'}; bảng mới: ${added.join(', ')}`);
  fs.writeFileSync(doneFile, JSON.stringify(log, null, 2), { mode: 0o600 });
  await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
  await client.end();
  console.log(`KẾT QUẢ run: 8/8 áp dụng — ghi ${doneFile}`);
  if (changed.length) process.exit(7);
}

main().catch((error) => fail(error && error.message));
