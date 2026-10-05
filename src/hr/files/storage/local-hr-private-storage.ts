import { Logger } from '@nestjs/common';
import { constants, createReadStream, mkdirSync, accessSync } from 'fs';
import { access, mkdir, open, rm, stat } from 'fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';
import { Readable } from 'stream';
import {
  HrPrivateObjectStat,
  HrPrivateStorage,
  HrSignedReadUrl,
  STORAGE_KEY_PATTERN,
  UnavailableHrPrivateStorage,
} from './hr-private-storage';

export const HR_PRIVATE_STORAGE_DIR_ENV = 'HR_PRIVATE_STORAGE_DIR';

/** Thư mục đang được serve tĩnh (main.ts `/uploads`, ServeStatic `/apk`) hoặc dễ bị serve. */
export function staticRoots(projectRoot: string): string[] {
  return ['uploads', 'public', 'static', 'dist'].map((d) =>
    resolve(projectRoot, d),
  );
}

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Thư mục gốc kho riêng: tuyệt đối, KHÔNG nằm trong (và không chứa) thư mục
 * static nào. Trả lỗi dạng chuỗi an toàn để log (không in đường dẫn).
 */
export function validateStorageRoot(
  dir: string | undefined,
  projectRoot: string,
): { ok: true; root: string } | { ok: false; reason: string } {
  if (!dir?.trim()) {
    return { ok: false, reason: `thiếu ${HR_PRIVATE_STORAGE_DIR_ENV}` };
  }
  if (!isAbsolute(dir.trim())) {
    return {
      ok: false,
      reason: `${HR_PRIVATE_STORAGE_DIR_ENV} phải là đường dẫn tuyệt đối`,
    };
  }
  const root = resolve(dir.trim());
  for (const s of staticRoots(projectRoot)) {
    if (inside(root, s) || inside(s, root)) {
      return {
        ok: false,
        reason: `${HR_PRIVATE_STORAGE_DIR_ENV} trùng hoặc lồng với thư mục được serve tĩnh`,
      };
    }
  }
  return { ok: true, root };
}

/**
 * Adapter filesystem cho local/dev (và server một máy). Thư mục 0700, file
 * 0600 (trên POSIX; Windows bỏ qua mode — dùng ACL của thư mục).
 * Không hỗ trợ signed URL → service dùng token + endpoint `.../content`.
 */
export class LocalHrPrivateStorage implements HrPrivateStorage {
  readonly available = true;
  readonly supportsSignedUrls = false;

  constructor(private readonly root: string) {}

  static fromEnv(
    env: NodeJS.ProcessEnv,
    projectRoot = process.cwd(),
    logger: Pick<Logger, 'log' | 'warn'> = new Logger('HrPrivateStorage'),
  ): HrPrivateStorage {
    const checked = validateStorageRoot(
      env[HR_PRIVATE_STORAGE_DIR_ENV],
      projectRoot,
    );
    if (!checked.ok) {
      logger.warn(`HR private storage unavailable — ${checked.reason}`);
      return new UnavailableHrPrivateStorage();
    }
    try {
      mkdirSync(checked.root, { recursive: true, mode: 0o700 });
      accessSync(checked.root, constants.R_OK | constants.W_OK);
    } catch (err) {
      logger.warn(
        `HR private storage unavailable — không tạo/ghi được thư mục ${HR_PRIVATE_STORAGE_DIR_ENV} (${(err as NodeJS.ErrnoException)?.code ?? 'lỗi'})`,
      );
      return new UnavailableHrPrivateStorage();
    }
    logger.log('HR private storage: local adapter sẵn sàng');
    return new LocalHrPrivateStorage(checked.root);
  }

  /** Key → đường dẫn; chặn mọi key không đúng dạng hoặc thoát khỏi thư mục gốc. */
  pathFor(key: string): string {
    if (typeof key !== 'string' || !STORAGE_KEY_PATTERN.test(key)) {
      throw new Error('Storage key không hợp lệ');
    }
    const full = resolve(this.root, ...key.split('/'));
    if (!full.startsWith(this.root + sep)) {
      throw new Error('Storage key thoát khỏi thư mục gốc');
    }
    return full;
  }

  async put(key: string, content: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // 'wx': lỗi EEXIST nếu đã có — không bao giờ ghi đè.
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => undefined);
      await rm(path, { force: true });
      throw err;
    }
    await handle.close();
  }

  openRead(key: string): Promise<Readable> {
    return Promise.resolve(createReadStream(this.pathFor(key)));
  }

  getSignedReadUrl(): Promise<HrSignedReadUrl> {
    return Promise.reject(
      new Error('Local adapter không hỗ trợ signed URL — dùng token endpoint'),
    );
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.pathFor(key), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async stat(key: string): Promise<HrPrivateObjectStat | null> {
    try {
      const s = await stat(this.pathFor(key));
      return s.isFile() ? { sizeBytes: s.size } : null;
    } catch {
      return null;
    }
  }
}
