import { Module } from '@nestjs/common';
import { HrAccessModule } from '../access/hr-access.module';
import { HrCryptoStatusController } from './hr-crypto-status.controller';
import { HrCryptoService } from './hr-crypto.service';

/**
 * Nạp keyring MỘT lần lúc khởi động, KHÔNG ném lỗi: thiếu/sai khoá → log an
 * toàn + trạng thái UNAVAILABLE; module cũ và API HR không cần crypto vẫn
 * chạy, chức năng cần crypto trả 503 (xem `HrCryptoService`).
 *
 * Nơi dùng chỉ lấy `HrCryptoService` — không inject thẳng
 * `HrEncryptionService` / `HrBlindIndexService` (chúng cần khoá hợp lệ).
 */
@Module({
  imports: [HrAccessModule],
  controllers: [HrCryptoStatusController],
  providers: [
    {
      provide: HrCryptoService,
      useFactory: () => HrCryptoService.fromEnv(process.env),
    },
  ],
  exports: [HrCryptoService],
})
export class HrCryptoModule {}
