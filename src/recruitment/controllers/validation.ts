import { ValidationPipe } from '@nestjs/common';

/**
 * Module mới nên chặt hơn phần còn lại của repo: khoá lạ trong body bị trả 400
 * (`forbidNonWhitelisted`) thay vì lặng lẽ bỏ — đó là cách chặn tiêu chí/thuộc
 * tính nhạy cảm lọt vào `screening_criteria` hay hồ sơ ứng viên.
 */
export function recruitmentValidationPipe() {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
}
