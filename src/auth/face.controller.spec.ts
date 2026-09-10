import { JwtAuthGuard } from './jwt-auth.guard';
import { FaceController } from './face.controller';

/**
 * Chốt **ai gọi được route nào** của FaceID.
 *
 * Guard trong Nest là một decorator lặng lẽ: xoá nhầm một dòng `@UseGuards`
 * thì không có lỗi biên dịch, không có test nào đỏ, route chỉ âm thầm mở ra
 * cho cả internet. Test này đọc thẳng metadata guard nên mọi thay đổi — thêm,
 * bớt, đổi guard — đều buộc phải sửa test một cách có ý thức.
 */
const guardsOf = (handler: unknown): string[] =>
  (Reflect.getMetadata('__guards__', handler as any) ?? []).map(
    (guard: any) => guard.name ?? guard.constructor?.name,
  );

describe('FaceController — phân quyền route', () => {
  it('cả controller không có guard chung: mỗi route tự khai', () => {
    // Nếu sau này ai đó gắn guard ở cấp class, các test dưới đây đọc thiếu —
    // nên chốt luôn giả định này.
    expect(guardsOf(FaceController)).toEqual([]);
  });

  it('POST /face/login mở công khai — đúng thiết kế', () => {
    // Đăng nhập thì không thể đòi token. Chốt lại để không ai "siết nhầm"
    // rồi khoá luôn đường đăng nhập.
    expect(guardsOf(FaceController.prototype.loginByFace)).toEqual([]);
  });

  it('POST /face/register-employee bắt buộc đăng nhập', () => {
    // Route này gắn khuôn mặt vào CHÍNH tài khoản đang đăng nhập (`req.user.id`).
    // Mất guard là mất luôn danh tính người gọi.
    expect(guardsOf(FaceController.prototype.registerEmployeeFace)).toEqual([
      JwtAuthGuard.name,
    ]);
  });

  /**
   * ⚠️ LỖ HỔNG ĐÃ BIẾT, TEST NÀY ĐANG CHỐT HIỆN TRẠNG CHỨ KHÔNG PHẢI CHỐT ĐÚNG.
   *
   * `registerByFace` **tạo mới một bản ghi Employee** với `roles: ['employee']`
   * rồi trả về JWT. Không có guard nghĩa là bất kỳ ai gọi được API đều tự tạo
   * được tài khoản thật và đăng nhập.
   *
   * Khi vá: thêm `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(...)` cho
   * route, rồi đổi kỳ vọng dưới đây thành `[JwtAuthGuard.name, RolesGuard.name]`.
   * Test đỏ ở đây là dấu hiệu TỐT — nghĩa là lỗ hổng vừa được bịt.
   */
  it('POST /face/register hiện KHÔNG có guard (lỗ hổng, chưa vá)', () => {
    expect(guardsOf(FaceController.prototype.registerByFace)).toEqual([]);
  });
});
