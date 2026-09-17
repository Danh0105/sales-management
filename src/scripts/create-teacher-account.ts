/**
 * Tạo tài khoản giáo viên từ dòng lệnh.
 *
 * Dùng khi cần mở tài khoản mà không đi qua giao diện Nhân sự (ví dụ giáo viên
 * đầu tiên của một đợt, hoặc lúc FE chưa sẵn sàng). Cố ý gọi thẳng
 * `TeacherService.create` thay vì INSERT tay: toàn bộ kiểm tra trùng số điện
 * thoại/email, băm bcrypt và transaction đều nằm trong đó, viết SQL thô là bỏ
 * qua hết và tạo ra bản ghi hỏng.
 *
 *   npm run teacher:create -- --name "Nguyen Van A" \
 *     --phone 0358326049 --email a@example.com \
 *     [--password ...] [--ctv] [--rate 240000]
 *
 * Bỏ trống --password thì dùng mật khẩu mặc định như luồng reset của hệ thống;
 * giáo viên phải đổi ngay ở lần đăng nhập đầu.
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { TeacherService } from '../teaching/teacher.service';
import {
  TEACHER_STAFF_ROLE,
  TEACHER_COLLABORATOR_ROLE,
} from '../teaching/teaching-roles';

const DEFAULT_PASSWORD = '123456';

/**
 * Gom mọi token tới cờ kế tiếp, vì `npm run -- --name "Ho Ten"` có thể tách
 * giá trị có dấu cách thành nhiều phần tử argv.
 */
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;

  const parts: string[] = [];
  for (let i = index + 1; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) break;
    parts.push(process.argv[i]);
  }
  return parts.length ? parts.join(' ') : undefined;
}

async function main() {
  const name = arg('name');
  const phoneRaw = arg('phone');
  const email = arg('email');

  if (!name || !phoneRaw || !email) {
    console.error(
      'Thiếu tham số. Bắt buộc: --name, --phone, --email.\n' +
        'Tuỳ chọn: --password (mặc định 123456), --ctv (cộng tác viên), ' +
        '--rate (đơn giá mỗi tiết, VND).',
    );
    process.exit(1);
  }

  // Số điện thoại thường được chép từ danh bạ nên hay dính khoảng trắng, dấu
  // chấm hoặc gạch ngang; DTO chỉ nhận đúng chuỗi chữ số.
  const phone = phoneRaw.replace(/[^\d]/g, '');
  const password = arg('password') || DEFAULT_PASSWORD;
  const teacherRole = process.argv.includes('--ctv')
    ? TEACHER_COLLABORATOR_ROLE
    : TEACHER_STAFF_ROLE;

  // Đơn giá hay được gõ kèm dấu chấm/phẩy phân cách nghìn ("240.000").
  const rateRaw = arg('rate');
  const defaultRatePerPeriod =
    rateRaw === undefined ? undefined : Number(rateRaw.replace(/[^\d]/g, ''));
  if (defaultRatePerPeriod !== undefined && !(defaultRatePerPeriod > 0)) {
    console.error(`--rate không hợp lệ: ${rateRaw}`);
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const teacher = await app.get(TeacherService).create({
      name,
      phone,
      email,
      password,
      teacherRole,
      defaultRatePerPeriod,
      isActive: true,
    } as never);

    console.log('Đã tạo giáo viên:');
    console.log(JSON.stringify(teacher, null, 2));
    console.log(
      `\nĐăng nhập bằng số điện thoại ${phone}` +
        (arg('password') ? '' : ` / mật khẩu mặc định ${DEFAULT_PASSWORD}`),
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Tạo tài khoản thất bại:');
  console.error(error?.response ?? error?.message ?? error);
  process.exit(1);
});
