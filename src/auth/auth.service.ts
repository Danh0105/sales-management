import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { EmployeeService } from '../employee/employee.service';
import { TEACHER_ROLES } from '../teaching/teaching-roles';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private readonly employeeService: EmployeeService,
    private readonly jwtService: JwtService,
  ) {}

  async login(
    phone: string,
    password: string,
    zalo?: { uid?: string; zaloId?: string },
  ) {
    const user = await this.employeeService.findByPhone(phone);
    if (!user) {
      throw new UnauthorizedException('Sai số điện thoại hoặc mật khẩu');
    }

    const isMatch = await bcrypt.compare(password, user.password || '');
    if (!isMatch) {
      throw new UnauthorizedException('Sai số điện thoại hoặc mật khẩu');
    }

    // Nhận biết Mini App qua sự có mặt của `uid`: chỉ Mini App lấy được
    // `userInfo.id` từ Zalo SDK, còn web/app thường không gửi field này. Nhờ
    // vậy siết Mini App mà không đụng gì tới các client đang chạy.
    //
    // Chốt này đặt **sau** bước so mật khẩu, không phải trước: kiểm role trước
    // khi xác thực sẽ để lộ "số điện thoại này là giáo viên" cho người chỉ đoán
    // số mà chưa có mật khẩu.
    const fromMiniApp = Boolean(zalo?.uid?.trim());
    const isTeacher =
      user.roles?.some((r) => TEACHER_ROLES.includes(r)) ?? false;

    if (fromMiniApp && isTeacher && !zalo?.zaloId?.trim()) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'ZALO_ID_REQUIRED',
        message:
          'Thiếu zaloId. Vui lòng quan tâm OA của trường rồi mở lại ứng dụng để đăng nhập.',
      });
    }

    // Lần đầu đăng nhập Mini App thì zaloId gửi lên được ghi nhận làm mốc
    // (bootstrap ở saveTeacherZaloIdentifiers bên dưới). Từ lần thứ hai trở
    // đi, zaloId gửi lên phải khớp mốc đã lưu — khác đi (đổi điện thoại/tài
    // khoản Zalo khác) bị từ chối thẳng, không âm thầm ghi đè, để tránh ai
    // đó ngoài ý muốn nhận thay cảnh báo của đúng giáo viên này.
    if (fromMiniApp && isTeacher) {
      const boundZaloId = user.zaloUserId?.trim();
      const incomingZaloId = zalo!.zaloId!.trim();
      if (boundZaloId && boundZaloId !== incomingZaloId) {
        throw new UnauthorizedException({
          statusCode: 401,
          code: 'ZALO_ID_MISMATCH',
          message:
            'Tài khoản Zalo không khớp với tài khoản đã liên kết trước đó. Vui lòng liên hệ Nhân sự để được hỗ trợ.',
        });
      }
    }

    // Chỉ liên kết sau khi tài khoản đã xác thực thành công. `zaloId` là
    // idByOA dùng để gửi cảnh báo; `uid` là ID theo Mini App để đối soát.
    if (isTeacher) {
      await this.employeeService.saveTeacherZaloIdentifiers(user.id!, {
        uid: zalo?.uid,
        zaloId: zalo?.zaloId,
      });
    }

    const payload = {
      sub: user.id,
      roles: user.roles ?? [],
      name: user.name,
    };

    const access_token = this.jwtService.sign(payload);

    return {
      access_token,
      user: {
        id: user.id,
        name: user.name,
        roles: user.roles ?? [],
        ...(isTeacher && {
          zaloUid: zalo?.uid?.trim() || user.zaloUid || null,
          zaloId: zalo?.zaloId?.trim() || user.zaloUserId || null,
        }),
      },
    };
  }
}
