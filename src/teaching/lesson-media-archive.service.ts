import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { access, mkdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { join, resolve, sep } from 'path';

/**
 * Tốc độ ghi NAS thấp nhất còn coi là bình thường (đo 26/10/2026: ~28 MB/s).
 * Dùng để nới hạn cho lần ghi file lớn — video báo giảng tới 50 MB.
 */
const MIN_WRITE_BYTES_PER_MS = (4 * 1024 * 1024) / 1000;

/**
 * Tầng lưu trữ ảnh/video chấm công & báo giảng.
 *
 *   cũ    : uploads/lesson-images/          trên VPS — chỉ đọc dữ liệu lịch sử
 *   mới  : NAS (NFS/CIFS)                   — bản gốc và thumbnail được ghi
 *                                            thẳng từ buffer của request
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
  /** Rỗng = chỉ đọc được file cũ; submit file mới sẽ bị từ chối. */
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
    this.probeTimeoutMs =
      Number(config.get('LESSON_IMAGE_ARCHIVE_TIMEOUT_MS')) || 3000;
    this.cooldownMs =
      Number(config.get('LESSON_IMAGE_ARCHIVE_COOLDOWN_MS')) || 30_000;

    if (this.archiveDir) {
      this.logger.log(
        `Tầng lạnh: ${this.archiveDir} (timeout ${this.probeTimeoutMs}ms)`,
      );
    }
  }

  /** Tên file hợp lệ trong kho — chặn path traversal ngay từ đầu vào. */
  static isValidName(name: string): boolean {
    return /^[0-9a-f-]{36}\.(webp|mp4|mov|webm)$/i.test(name);
  }

  get configured(): boolean {
    return Boolean(this.archiveDir);
  }

  /**
   * Ghi file submit mới thẳng lên NAS. Không có fallback xuống VPS:
   * NAS chưa cấu hình, bị ngắt hoặc path không còn là network mount
   * đều là lỗi để request submit thử lại sau.
   */
  async store(
    name: string,
    content: Buffer,
    thumbnail?: Buffer,
  ): Promise<void> {
    if (!LessonMediaArchiveService.isValidName(name)) {
      throw new Error('Tên file minh chứng không hợp lệ');
    }
    if (!this.archiveDir) {
      throw new Error('Chưa cấu hình kho NAS cho minh chứng bài dạy');
    }
    if (!this.archiveAvailable()) {
      throw new Error('Kho NAS đang tạm ngắt');
    }

    const archived = resolve(this.archiveDir, name);
    const thumbnailName = name.replace(/\.[^.]+$/, '.webp');
    const archivedThumbnail = resolve(this.archiveDir, 'thumb', thumbnailName);
    if (
      !archived.startsWith(`${this.archiveDir}${sep}`) ||
      !archivedThumbnail.startsWith(`${this.archiveDir}${sep}thumb${sep}`)
    ) {
      throw new Error('Tên file minh chứng không an toàn');
    }

    try {
      await this.assertNetworkMount();
      await this.withTimeout(
        this.writeToArchive(
          archived,
          content,
          thumbnail ? archivedThumbnail : null,
          thumbnail,
        ),
        this.writeTimeoutMs(content.byteLength + (thumbnail?.byteLength ?? 0)),
      );
      this.failures = 0;
    } catch (error) {
      this.trip(error);
      // Dọn phần đã ghi nếu thao tác thứ hai bị lỗi. Việc dọn chỉ
      // đụng NAS, tuyệt đối không tạo bản fallback trên VPS.
      await this.withTimeout(
        Promise.all([
          this.unlinkQuiet(archived),
          thumbnail ? this.unlinkQuiet(archivedThumbnail) : Promise.resolve(),
        ]),
      ).catch(() => undefined);
      throw error;
    }
  }

  /** Lưu thumbnail sinh bù cho dữ liệu cũ thẳng lên NAS. */
  async storeThumbnail(name: string, content: Buffer): Promise<void> {
    if (!LessonMediaArchiveService.isValidName(name)) {
      throw new Error('Tên thumbnail không hợp lệ');
    }
    if (!this.archiveDir || !this.archiveAvailable()) {
      throw new Error('Kho NAS đang tạm ngắt');
    }
    const thumbnail = resolve(
      this.archiveDir,
      'thumb',
      name.replace(/\.[^.]+$/, '.webp'),
    );
    if (!thumbnail.startsWith(`${this.archiveDir}${sep}thumb${sep}`)) {
      throw new Error('Tên thumbnail không an toàn');
    }
    try {
      await this.assertNetworkMount();
      await this.withTimeout(this.writeOne(thumbnail, content));
      this.failures = 0;
    } catch (error) {
      this.trip(error);
      await this.unlinkQuiet(thumbnail).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Tìm đường dẫn đọc được của một file, theo thứ tự nóng → lạnh.
   * Trả `null` khi không có ở đâu cả hoặc NAS đang bị ngắt.
   */
  async locate(
    name: string,
  ): Promise<{ path: string; tier: 'local' | 'archive' } | null> {
    if (!LessonMediaArchiveService.isValidName(name)) return null;

    const local = resolve(this.localDir, name);
    if (
      local.startsWith(`${this.localDir}${sep}`) &&
      (await this.exists(local))
    ) {
      return { path: local, tier: 'local' };
    }

    if (!this.archiveDir || !this.archiveAvailable()) return null;

    const archived = resolve(this.archiveDir, name);
    if (!archived.startsWith(`${this.archiveDir}${sep}`)) return null;

    try {
      await this.assertNetworkMount();
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

  /** Tìm thumbnail cũ trên VPS trước, sau đó tìm thumbnail mới trên NAS. */
  async locateThumbnail(name: string): Promise<string | null> {
    if (!LessonMediaArchiveService.isValidName(name)) return null;
    const thumb = resolve(
      this.localDir,
      'thumb',
      name.replace(/\.[^.]+$/, '.webp'),
    );
    if (!thumb.startsWith(`${this.localDir}${sep}thumb${sep}`)) return null;
    if (await this.exists(thumb)) return thumb;

    if (!this.archiveDir || !this.archiveAvailable()) return null;
    const archived = resolve(
      this.archiveDir,
      'thumb',
      name.replace(/\.[^.]+$/, '.webp'),
    );
    if (!archived.startsWith(`${this.archiveDir}${sep}thumb${sep}`))
      return null;
    try {
      await this.assertNetworkMount();
      const found = await this.withTimeout(this.exists(archived));
      if (found) this.failures = 0;
      return found ? archived : null;
    } catch (error) {
      this.trip(error);
      return null;
    }
  }

  /** Xóa bản gốc và thumbnail trên NAS khi transaction bị rollback. */
  async removeArchived(name: string): Promise<void> {
    if (!LessonMediaArchiveService.isValidName(name)) return;
    if (!this.archiveDir || !this.archiveAvailable()) return;
    const archived = resolve(this.archiveDir, name);
    const thumbnail = resolve(
      this.archiveDir,
      'thumb',
      name.replace(/\.[^.]+$/, '.webp'),
    );
    if (
      !archived.startsWith(`${this.archiveDir}${sep}`) ||
      !thumbnail.startsWith(`${this.archiveDir}${sep}thumb${sep}`)
    )
      return;
    try {
      await this.assertNetworkMount();
      await this.withTimeout(
        Promise.all([this.unlinkQuiet(archived), this.unlinkQuiet(thumbnail)]),
      );
      this.failures = 0;
    } catch (error) {
      this.trip(error);
    }
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
      reopensAt: this.openedUntil
        ? new Date(this.openedUntil).toISOString()
        : null,
    };
  }

  private trip(error: unknown): void {
    this.failures += 1;
    this.openedUntil = Date.now() + this.cooldownMs;
    this.logger.error(
      `[LESSON_MEDIA_ARCHIVE] NAS không phản hồi (${String(
        (error as Error)?.message ?? error,
      )}). Ngắt truy cập NAS ${this.cooldownMs}ms. Lỗi liên tiếp: ${this.failures}`,
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
   * Hạn cho một lần ghi = hạn thăm dò + thời gian đẩy dữ liệu ở tốc độ thấp
   * nhất chấp nhận được. Chỉ dùng `probeTimeoutMs` thì video 50 MB quá hạn
   * khi vài giáo viên gửi cùng lúc, và breaker ngắt NAS của mọi người dù
   * NAS vẫn sống. NAS chết thật đã bị bắt ở bước thăm dò mount trước đó.
   */
  private writeTimeoutMs(bytes: number): number {
    return this.probeTimeoutMs + Math.ceil(bytes / MIN_WRITE_BYTES_PER_MS);
  }

  private async writeToArchive(
    archived: string,
    content: Buffer,
    archivedThumbnail: string | null,
    thumbnail?: Buffer,
  ): Promise<void> {
    await mkdir(this.archiveDir, { recursive: true });
    await writeFile(archived, content, { flag: 'wx' });
    if (archivedThumbnail && thumbnail) {
      await mkdir(resolve(this.archiveDir, 'thumb'), { recursive: true });
      await writeFile(archivedThumbnail, thumbnail, { flag: 'wx' });
    }
  }

  private async writeOne(target: string, content: Buffer): Promise<void> {
    await mkdir(resolve(this.archiveDir, 'thumb'), { recursive: true });
    await writeFile(target, content, { flag: 'wx' });
  }

  private async unlinkQuiet(path: string): Promise<void> {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  /**
   * Fail closed nếu mount NFS/CIFS bị rớt. Nếu chỉ kiểm tra path,
   * `/mnt/...` có thể trở thành thư mục local và lặng lẽ lấp đầy VPS.
   * Jest dùng thư mục tạm để kiểm thử logic I/O nên được bỏ qua
   * duy nhất trong NODE_ENV=test.
   */
  private async assertNetworkMount(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    // `/mnt/nas-var` là systemd automount, tự gỡ NFS sau 60s không dùng.
    // Đọc mountinfo lúc đó chỉ thấy autofs, nên phải đi qua path trước để
    // kích mount. ENOENT nghĩa là đã đi qua điểm mount; mountinfo quyết tiếp.
    await this.withTimeout(
      stat(this.archiveDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      }),
    );
    const mountInfo = await readFile('/proc/self/mountinfo', 'utf8');
    const networkTypes = new Set(['nfs', 'nfs4', 'cifs', 'smb3']);
    const mounted = mountInfo.split('\n').some((line) => {
      const [mount, filesystem = ''] = line.split(' - ');
      if (!mount || !filesystem) return false;
      const fields = mount.split(' ');
      const mountPoint = (fields[4] || '').replace(/\\040/g, ' ');
      const fsType = filesystem.split(' ')[0];
      return (
        networkTypes.has(fsType) &&
        (this.archiveDir === mountPoint ||
          this.archiveDir.startsWith(`${mountPoint}${sep}`))
      );
    });
    if (!mounted) {
      throw new Error('Thư mục lưu minh chứng không nằm trên NAS đang mount');
    }
  }

  /**
   * Quá hạn thì trả lỗi ngay cho request, nhưng lưu ý promise gốc vẫn đang
   * chiếm một thread threadpool cho tới khi NFS tự bỏ cuộc — đó là lý do phải
   * có breaker chứ không chỉ timeout.
   */
  private withTimeout<T>(
    promise: Promise<T>,
    ms = this.probeTimeoutMs,
  ): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`quá ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}
