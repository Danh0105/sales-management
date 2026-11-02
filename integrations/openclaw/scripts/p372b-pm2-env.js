#!/usr/bin/env node
// P3-7.2B (M2, bắt buộc) — đặt biến tuyển dụng CHỈ cho tiến trình 3010 (`sales-management`) hoặc tiến trình tạm
// cutover (`sales-recruit-cutover`, 3017) qua env của pm2, KHÔNG ghi vào `.env` dùng chung (3011 công khai cũng
// đọc file đó). Giá trị secret đi thẳng từ file 600 vào env của lệnh pm2 (spawn với env object) — KHÔNG xuất hiện
// trên dòng lệnh / `ps` / lịch sử shell. pm2 `--update-env` GỘP biến vào env sẵn có của tiến trình (đã thử), không
// xoá biến cũ; env pm2 thắng `.env` (dotenv/ConfigModule không ghi đè biến đã có — đã thử).
//
//   node p372b-pm2-env.js --app <app> --env-file <file 600>… --keys K1,K2,… [--set K=giá trị]… [--dry-run]
//        [--start <script> --cwd <thư mục>]
//     --keys  : chỉ lấy đúng các biến này từ các file (thiếu / rỗng → dừng)
//     --set   : cờ KHÔNG bí mật (vd. RECRUITMENT_ZALO_ENABLED=true); từ chối nếu tên chứa SECRET/KEY/TOKEN/PASSWORD
//     --start : tạo tiến trình mới (`pm2 start <script> --name <app> --cwd <thư mục>`) thay vì restart
//   Chỉ in TÊN biến. Mặc định chỉ chấp nhận `sales-management` và `sales-recruit-cutover`; `sales-be` (3011) luôn
//   bị từ chối. `pm2 save` ghi env (kể cả secret) vào dump.pm2 / dump.pm2.bak → hai file đó phải 600, nếu không dừng.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const one = (name) => all(name)[0];
const dryRun = args.includes('--dry-run');

const ALLOWED_APPS = new Set((process.env.P372B_ALLOWED_APPS || 'sales-management,sales-recruit-cutover').split(','));
const app = one('--app');
if (app === 'sales-be') fail('sales-be (3011, công khai) không bao giờ nhận biến tuyển dụng');
if (!ALLOWED_APPS.has(app)) fail(`app "${app}" không được phép (chỉ ${[...ALLOWED_APPS].join(', ')})`);
const start = one('--start');
const cwd = one('--cwd');
if (start && !cwd) fail('--start cần --cwd (thư mục có .env của ứng dụng)');

const pm2Home = process.env.PM2_HOME || path.join(process.env.HOME || '/root', '.pm2');
for (const name of ['dump.pm2', 'dump.pm2.bak']) {
  const file = path.join(pm2Home, name);
  if (!fs.existsSync(file)) continue;
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) fail(`${file} đang ${mode.toString(8)} — \`pm2 save\` sẽ ghi secret vào đó; chmod 600 trước`);
}

const dotenv = require(require.resolve('dotenv', { paths: [process.cwd(), path.join(__dirname, '../../..')] }));
const files = all('--env-file');
const fromFiles = {};
for (const file of files) {
  const st = fs.statSync(file);
  if ((st.mode & 0o077) !== 0) fail(`${file} phải có quyền 600 (hiện ${(st.mode & 0o777).toString(8)})`);
  Object.assign(fromFiles, dotenv.parse(fs.readFileSync(file)));
}
const keys = (one('--keys') || '').split(',').filter(Boolean);
const selected = {};
for (const key of keys) {
  const value = (fromFiles[key] ?? '').trim();
  if (!value) fail(`thiếu ${key} trong ${files.join(', ')}`);
  selected[key] = value;
}
for (const pair of all('--set')) {
  const [key, ...rest] = pair.split('=');
  if (/SECRET|KEY|TOKEN|PASSWORD/i.test(key)) fail(`--set không dùng cho biến bí mật (${key}) — đưa vào file 600 + --keys`);
  selected[key] = rest.join('=');
}
if (!Object.keys(selected).length) fail('không có biến nào để đặt');

const env = { PATH: process.env.PATH, HOME: process.env.HOME };
if (process.env.PM2_HOME) env.PM2_HOME = process.env.PM2_HOME;
Object.assign(env, selected);
const pm2Args = start ? ['start', path.resolve(start), '--name', app, '--cwd', path.resolve(cwd)] : ['restart', app, '--update-env'];
console.log(`${start ? 'tạo' : 'đặt cho'} ${app}: ${Object.keys(selected).map((k) => (keys.includes(k) ? `${k}=<bí mật từ file>` : `${k}=${selected[k]}`)).join(' ')}`);
if (dryRun) {
  console.log(`dry-run: không gọi pm2 (${pm2Args[0]})`);
  process.exit(0);
}
const res = spawnSync('pm2', pm2Args, { env, cwd: start ? path.resolve(cwd) : undefined, encoding: 'utf8' });
if (res.status !== 0) fail(`pm2 ${pm2Args[0]} lỗi (exit ${res.status})`);
console.log(`pm2 ${pm2Args.slice(0, 2).join(' ')}: OK — nhớ \`pm2 save\` nếu muốn giữ qua reboot`);

function fail(message) {
  console.error(`DỪNG: ${message}`);
  process.exit(1);
}
