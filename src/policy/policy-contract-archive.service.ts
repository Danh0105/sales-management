import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { access, stat } from 'fs/promises';
import { join, resolve, sep } from 'path';

/**
 * Tầng lưu trữ file hợp đồng/BBCS/ảnh bàn giao chính sách — cùng mẫu với
 * `LessonMediaArchiveService`.
 *
 *   nóng : uploads/policy-contracts/  trên VPS — chỉ tồn tại tạm trong lúc
 *          upload, request tự chuyển sang NAS ngay rồi xoá bản local.
 *   lạnh : NAS (NFS)                  — nơi lưu lâu dài; BE đọc trực tiếp
 *          từ đây khi phục vụ file cho FE.
 *
 * Bài học ngày 10/9/2026 (xem `LessonMediaArchiveService`): NAS chết làm mount
 * NFS treo, mọi lời gọi fs chạm vào NAS phải đi qua timeout + circuit breaker,
 * không thì một request kẹt cũng đủ chiếm hết libuv threadpool và khoá VPS.
 */
@Injectable()
export class PolicyContractArchiveService {
  private readonly logger = new Logger(PolicyContractArchiveService.name);

  readonly localDir: string;
  /** Rỗng = chưa cấu hình NAS, file ở lại VPS như trước. */
  readonly archiveDir: string;

  private readonly probeTimeoutMs: number;
  private readonly cooldownMs: number;

  private openedUntil = 0;
  private failures = 0;

  constructor(config: ConfigService) {
    this.localDir = resolve(
      config.get('POLICY_CONTRACT_UPLOAD_DIR') ||
        join(process.cwd(), 'uploads', 'policy-contracts'),
    );
    const archive = config.get<string>('POLICY_CONTRACT_ARCHIVE_DIR')?.trim();
    this.archiveDir = archive ? resolve(archive) : '';
    this.probeTimeoutMs = Number(config.get('POLICY_CONTRACT_ARCHIVE_TIMEOUT_MS')) || 3000;
    this.cooldownMs = Number(config.get('POLICY_CONTRACT_ARCHIVE_COOLDOWN_MS')) || 30_000;

    if (this.archiveDir) {
      this.logger.log(`Tầng lạnh: ${this.archiveDir} (timeout ${this.probeTimeoutMs}ms)`);
    }
  }

  /** Tên file hợp lệ — UUID + đuôi cho phép, chặn path traversal từ đầu vào. */
  static isValidName(name: string): boolean {
    return /^[0-9a-f-]{36}\.(pdf|jpe?g|png)$/i.test(name);
  }

  get configured(): boolean {
    return Boolean(this.archiveDir);
  }

  /** NAS có đang được phép chạm tới không (breaker đóng). */
  archiveAvailable(): boolean {
    return Date.now() >= this.openedUntil;
  }

  /**
   * Tìm đường dẫn đọc được của một file, theo thứ tự nóng → lạnh.
   * Trả `null` khi không có ở đâu cả hoặc NAS đang bị ngắt.
   */
  async locate(name: string): Promise<{ path: string; tier: 'local' | 'archive' } | null> {
    if (!PolicyContractArchiveService.isValidName(name)) return null;

    const local = resolve(this.localDir, name);
    if (local.startsWith(`${this.localDir}${sep}`) && (await this.exists(local))) {
      return { path: local, tier: 'local' };
    }

    if (!this.archiveDir || !this.archiveAvailable()) return null;

    const archived = resolve(this.archiveDir, name);
    if (!archived.startsWith(`${this.archiveDir}${sep}`)) return null;

    try {
      const found = await this.withTimeout(this.exists(archived));
      if (found) {
        this.failures = 0;
        return { path: archived, tier: 'archive' };
      }
      return null;
    } catch (error) {
      this.trip(error);
      return null;
    }
  }

  /**
   * Di chuyển một file vừa ghi ở tầng nóng sang NAS, có timeout + breaker.
   * Trả `true` nếu đã chuyển thành công (gọi nơi khác xoá bản local); `false`
   * thì cứ để nguyên file ở VPS — an toàn hơn là mất dữ liệu.
   */
  async archive(name: string): Promise<boolean> {
    if (!this.archiveDir || !this.archiveAvailable()) return false;

    const local = resolve(this.localDir, name);
    const archived = resolve(this.archiveDir, name);
    if (
      !local.startsWith(`${this.localDir}${sep}`) ||
      !archived.startsWith(`${this.archiveDir}${sep}`)
    ) {
      return false;
    }

    try {
      await this.withTimeout(this.copy(local, archived));
      this.failures = 0;
      return true;
    } catch (error) {
      this.trip(error);
      return false;
    }
  }

  /** Xoá bản lưu trữ trên NAS (nếu có), có timeout + breaker giống mọi thao tác NAS khác. */
  async removeArchived(name: string): Promise<void> {
    if (!this.archiveDir || !this.archiveAvailable()) return;

    const archived = resolve(this.archiveDir, name);
    if (!archived.startsWith(`${this.archiveDir}${sep}`)) return;

    try {
      await this.withTimeout(this.unlinkQuiet(archived));
      this.failures = 0;
    } catch (error) {
      this.trip(error);
    }
  }

  /** Trạng thái để theo dõi / health-check. */
  status() {
    return {
      archiveDir: this.archiveDir || null,
      available: this.archiveAvailable(),
      failures: this.failures,
      reopensAt: this.openedUntil ? new Date(this.openedUntil).toISOString() : null,
    };
  }

  private trip(error: unknown): void {
    this.failures += 1;
    this.openedUntil = Date.now() + this.cooldownMs;
    this.logger.error(
      `[POLICY_CONTRACT_ARCHIVE] NAS không phản hồi (${String(
        (error as Error)?.message ?? error,
      )}). Ngắt tầng lạnh ${this.cooldownMs}ms. Lỗi liên tiếp: ${this.failures}`,
    );
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      const info = await stat(path);
      return info.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async copy(source: string, target: string): Promise<void> {
    const { mkdir, copyFile, unlink } = await import('fs/promises');
    await mkdir(this.archiveDir, { recursive: true });
    await copyFile(source, target);
    await unlink(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  private async unlinkQuiet(path: string): Promise<void> {
    const { unlink } = await import('fs/promises');
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  /**
   * Quá hạn thì trả lỗi ngay cho request, nhưng lưu ý promise gốc vẫn đang
   * chiếm một thread threadpool cho tới khi NFS tự bỏ cuộc — đó là lý do phải
   * có breaker chứ không chỉ timeout.
   */
  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`quá ${this.probeTimeoutMs}ms`)),
        this.probeTimeoutMs,
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}
