import {
  type CanActivate,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

import { RecruitmentRuntimeControlService } from '../channels/recruitment-runtime-control.service';

/**
 * Dừng khẩn AI (P3-7.3 / G8) cho API `/recruitment/ai/*`: chạy SAU guard xác thực — đang dừng
 * (hoặc không đọc được trạng thái — fail-closed) → 503 `AI_HALTED`, không chạm dữ liệu.
 */
@Injectable()
export class RecruitmentAiRuntimeGuard implements CanActivate {
  constructor(private readonly runtime: RecruitmentRuntimeControlService) {}

  async canActivate(): Promise<boolean> {
    // Mỗi tool request đọc DB mới: không có cửa sổ cache 1 giây sau emergency stop.
    const state = await this.runtime.state();
    if (state.aiHalted) {
      throw new ServiceUnavailableException({
        code: 'AI_HALTED',
        message: 'AI tuyển dụng đang dừng khẩn',
      });
    }
    return true;
  }
}
