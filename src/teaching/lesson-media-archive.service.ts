import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { access, stat } from 'fs/promises';
import { join, resolve, sep } from 'path';

/**
 * Tầng lưu trữ ảnh/video chấm công & báo giảng.
 *
 *   nóng  : uploads/lesson-images/          trên VPS — file mới, phục vụ trực tiếp
 *   lạnh  : NAS (NFS)                        — file cũ đã được cron đêm chuyển đi
 *   thumb : uploads/lesson-images/thumb/     KHÔNG BAO GIỜ chuyển — đây là phương án
 *                                            dự phòng khi NAS mất kết nối
 *
 * Bài học ngày 10/9/2026: NAS chết, mount NFS treo, nginx worker bị khoá ở
 * D-state 9–30s mỗi lần `open()`, và toàn bộ site trên VPS đứng 22 giây. Vì
 * vậy mọi lần chạm vào NAS ở đây đều đi qua một circuit breaker: một lần lỗi
 * hoặc quá hạn là đóng cửa NAS `COOLDOWN_MS`, các request sau trả dự phòng
 * ngay lập tức mà không đụng NFS. Không có breaker thì mỗi request kẹt sẽ
 * chiếm một thread trong libuv threadpool (mặc định 4) và app tự khoá mình.
 */
@Injectable()
export class LessonMediaArchiveService {
  private readonly logger = new Logger(LessonMediaArchiveService.name);

  readonly localDir: string;
  /** Rỗng = chưa cấu hình tầng lạnh, mọi thứ hoạt động như cũ. */
  readonly archiveDir: string;

  /** Chờ NAS tối đa ngần này rồi trả dự phòng cho client. */
  private readonly probeTimeoutMs: number;
  /** Sau một lần lỗi, không chạm NAS trong ngần này. */
  private readonly cooldownMs: number;

  private openedUntil = 0;
  private failures = 0;

  constructor(config: ConfigService) {
    this.localDir = resolve(
      config.get('LESSON_IMAGE_UPLOAD_DIR') ||
        join(process.cwd(), 'uploads', 'lesson-images'),
    );
    const archive = config.get<string>('LESSON_IMAGE_ARCHIVE_DIR')?.trim();
    this.archiveDir = archive ? resolve(archive) : '';
    this.probeTimeoutMs = Number(config.get('LESSON_IMAGE_ARCHIVE_TIMEOUT_MS')) || 3000;
    this.cooldownMs = Number(config.get('LESSON_IMAGE_ARCHIVE_COOLDOWN_MS')) || 30_000;

    if (this.archiveDir) {
      this.logger.log(`Tầng lạnh: ${this.archiveDir} (timeout ${this.probeTimeoutMs}ms)`);
    }
  }

  /** Tên file hợp lệ trong kho — chặn path traversal ngay từ đầu vào. */
  static isValidName(name: string): boolean {
    return /^[0-9a-f-]{36}\.(webp|mp4|mov|webm)$/i.test(name);
  }

  /**
   * Tìm đường dẫn đọc được của một file, theo thứ tự nóng → lạnh.
   * Trả `null` khi không có ở đâu cả hoặc NAS đang bị ngắt.
   */
  async locate(name: string): Promise<{ path: string; tier: 'local' | 'archive' } | null> {
    if (!LessonMediaArchiveService.isValidName(name)) return null;

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

  /** Thumbnail luôn nằm local — dùng làm ảnh dự phòng khi bản gốc không lấy được. */
  async locateThumbnail(name: string): Promise<string | null> {
    if (!LessonMediaArchiveService.isValidName(name)) return null;
    const thumb = resolve(this.localDir, 'thumb', name.replace(/\.[^.]+$/, '.webp'));
    if (!thumb.startsWith(`${this.localDir}${sep}thumb${sep}`)) return null;
    return (await this.exists(thumb)) ? thumb : null;
  }

  /** NAS có đang được phép chạm tới không (breaker đóng). */
  archiveAvailable(): boolean {
    return Date.now() >= this.openedUntil;
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
      `[LESSON_MEDIA_ARCHIVE] NAS không phản hồi (${String(
        (error as Error)?.message ?? error,
      )}). Ngắt tầng lạnh ${this.cooldownMs}ms, trả ảnh dự phòng. Lỗi liên tiếp: ${this.failures}`,
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
