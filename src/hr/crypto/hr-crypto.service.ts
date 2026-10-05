import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { HrBlindIndexService } from './hr-blind-index.service';
import { HrCryptoConfigError } from './hr-crypto.errors';
import { HrEncryptionService } from './hr-encryption.service';
import { HrKeyring, HrKeyPurpose, loadHrKeyring } from './hr-keyring';

export const HR_CRYPTO_UNAVAILABLE = 'HR_CRYPTO_UNAVAILABLE';

export interface HrCryptoStatus {
  status: 'AVAILABLE' | 'UNAVAILABLE';
  encryptionKeyringReady: boolean;
  hmacKeyringReady: boolean;
  activeEncryptionVersion: string | null;
  activeHmacVersion: string | null;
}

/**
 * Cửa duy nhất để lấy dịch vụ mã hoá / blind index.
 *
 * Degraded mode: cấu hình khoá thiếu/sai KHÔNG làm backend dừng khởi động —
 * module cũ và API HR không cần crypto vẫn chạy; chỉ chức năng cần crypto trả
 * `503 HR_CRYPTO_UNAVAILABLE`. Fail closed: không bao giờ fallback plaintext,
 * không trả ciphertext, không bỏ qua blind index.
 *
 * Chính sách triển khai vẫn là: production PHẢI có đủ khoá trước khi bật tính
 * năng HR nhạy cảm (checklist deploy) — degraded mode chỉ là lưới an toàn.
 */
export class HrCryptoService {
  private constructor(
    private readonly encryptionService: HrEncryptionService | null,
    private readonly blindIndexService: HrBlindIndexService | null,
  ) {}

  static fromKeyrings(
    encryption: HrKeyring | null,
    hmac: HrKeyring | null,
  ): HrCryptoService {
    return new HrCryptoService(
      encryption ? new HrEncryptionService(encryption) : null,
      hmac ? new HrBlindIndexService(hmac) : null,
    );
  }

  /**
   * Nạp khoá từ biến môi trường; lỗi → log an toàn (mã lỗi + TÊN biến, không
   * giá trị) và đánh dấu phần tương ứng UNAVAILABLE. Không bao giờ ném.
   */
  static fromEnv(
    env: NodeJS.ProcessEnv,
    logger: Pick<Logger, 'log' | 'warn'> = new Logger('HrCrypto'),
  ): HrCryptoService {
    const load = (purpose: HrKeyPurpose): HrKeyring | null => {
      try {
        return loadHrKeyring(env, purpose);
      } catch (err) {
        const detail =
          err instanceof HrCryptoConfigError
            ? err.message
            : `[HR_CRYPTO_CONFIG] lỗi không xác định (${(err as Error)?.name ?? 'Error'})`;
        logger.warn(`HR crypto unavailable — ${purpose}: ${detail}`);
        return null;
      }
    };

    let encryption = load('encryption');
    let hmac = load('hmac');
    if (encryption && hmac && encryption.sharesMaterialWith(hmac)) {
      logger.warn(
        'HR crypto unavailable — [HR_CRYPTO_CONFIG] một key HR_HMAC_KEY_V* trùng HR_ENCRYPTION_KEY_V*; hai loại phải sinh riêng.',
      );
      encryption = null;
      hmac = null;
    }

    const service = HrCryptoService.fromKeyrings(encryption, hmac);
    const s = service.status();
    if (s.status === 'AVAILABLE') {
      logger.log(
        `HR crypto available (encryption ${s.activeEncryptionVersion}, hmac ${s.activeHmacVersion})`,
      );
    }
    return service;
  }

  status(): HrCryptoStatus {
    const enc = this.encryptionService;
    const bi = this.blindIndexService;
    return {
      status: enc && bi ? 'AVAILABLE' : 'UNAVAILABLE',
      encryptionKeyringReady: !!enc,
      hmacKeyringReady: !!bi,
      activeEncryptionVersion: enc?.activeKeyVersion ?? null,
      activeHmacVersion: bi?.activeKeyVersion ?? null,
    };
  }

  /** Đọc (reveal) — chỉ cần khoá mã hoá. */
  encryption(): HrEncryptionService {
    if (!this.encryptionService) throw unavailable();
    return this.encryptionService;
  }

  /**
   * Ghi dữ liệu nhạy cảm — cần CẢ mã hoá lẫn blind index. Gọi TRƯỚC khi mở
   * transaction để không có gì được ghi khi crypto không sẵn sàng.
   */
  forSensitiveWrite(): {
    encryption: HrEncryptionService;
    blindIndex: HrBlindIndexService;
  } {
    if (!this.encryptionService || !this.blindIndexService) {
      throw unavailable();
    }
    return {
      encryption: this.encryptionService,
      blindIndex: this.blindIndexService,
    };
  }
}

function unavailable() {
  return new ServiceUnavailableException({
    statusCode: 503,
    code: HR_CRYPTO_UNAVAILABLE,
    message: 'HR sensitive data features are temporarily unavailable.',
    messageVi:
      'Chức năng dữ liệu nhạy cảm HR tạm thời không khả dụng (thiếu cấu hình mã hoá).',
  });
}
