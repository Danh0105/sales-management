import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Controller chạy `ValidationPipe({ whitelist: true })` — field nào không có
 * decorator của class-validator sẽ bị CẮT khỏi body trước khi vào service.
 * DTO này trước đây khai trần hai field nên body luôn về rỗng, và
 * `bcrypt.compare(undefined, hash)` ném "data and hash arguments required"
 * → mọi lần đổi mật khẩu đều 500. Giữ decorator ở đây là bắt buộc, không phải
 * để trang trí.
 */
export class ChangePasswordDto {
  @IsString({ message: 'Vui lòng nhập mật khẩu hiện tại' })
  @MinLength(1, { message: 'Vui lòng nhập mật khẩu hiện tại' })
  oldPassword!: string;

  @IsString({ message: 'Vui lòng nhập mật khẩu mới' })
  @MinLength(6, { message: 'Mật khẩu mới phải từ 6 ký tự trở lên' })
  // bcrypt chỉ băm 72 byte đầu — dài hơn là phần dư bị bỏ lặng lẽ, người dùng
  // tưởng mật khẩu mạnh hơn thực tế.
  @MaxLength(72, { message: 'Mật khẩu mới tối đa 72 ký tự' })
  newPassword!: string;
}
