import { ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';

/**
 * Kho file riêng tư của HR. Service nghiệp vụ CHỈ dùng interface này — không
 * import `fs`, SDK S3/MinIO. Đổi adapter (local → S3/MinIO) không sửa nghiệp vụ.
 *
 * - `put` tạo mới, KHÔNG BAO GIỜ ghi đè object đã có (upload phiên bản mới =
 *   key mới).
 * - `getSignedReadUrl`: adapter có URL ký sẵn (S3 presigned) trả về URL có hạn.
 *   Adapter không có (`supportsSignedUrls = false`, vd. local) → service cấp
 *   token một lần-hạn qua endpoint `.../content` và đọc bằng `openRead`.
 * - Key do `newStorageKey()` sinh (ngẫu nhiên), độc lập với tên file gốc.
 */
export interface HrPrivateObjectStat {
  sizeBytes: number;
}

export interface HrSignedReadUrl {
  url: string;
  expiresAt: Date;
}

export interface HrPrivateStorage {
  readonly available: boolean;
  readonly supportsSignedUrls: boolean;
  put(
    key: string,
    content: Buffer,
    meta: { contentType: string; sha256: string },
  ): Promise<void>;
  openRead(key: string): Promise<Readable>;
  getSignedReadUrl(
    key: string,
    options: { ttlSeconds: number; contentType: string; downloadName: string },
  ): Promise<HrSignedReadUrl>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<HrPrivateObjectStat | null>;
}

export const HR_PRIVATE_STORAGE = Symbol('HR_PRIVATE_STORAGE');

/** `ab/<uuid>` — 2 ký tự đầu làm thư mục con để không dồn 1 thư mục. */
export const STORAGE_KEY_PATTERN =
  /^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newStorageKey(): string {
  const id = randomUUID();
  return `${id.slice(0, 2)}/${id}`;
}

export const HR_FILE_STORAGE_UNAVAILABLE = 'HR_FILE_STORAGE_UNAVAILABLE';

export function storageUnavailable() {
  return new ServiceUnavailableException({
    statusCode: 503,
    code: HR_FILE_STORAGE_UNAVAILABLE,
    message: 'HR private file storage is not configured.',
    messageVi: 'Kho tài liệu HR riêng tư chưa được cấu hình.',
  });
}

/** Adapter khi cấu hình thiếu/sai: app vẫn chạy, chức năng file trả 503. */
export class UnavailableHrPrivateStorage implements HrPrivateStorage {
  readonly available = false;
  readonly supportsSignedUrls = false;
  put(): Promise<void> {
    return Promise.reject(storageUnavailable());
  }
  openRead(): Promise<Readable> {
    return Promise.reject(storageUnavailable());
  }
  getSignedReadUrl(): Promise<HrSignedReadUrl> {
    return Promise.reject(storageUnavailable());
  }
  delete(): Promise<void> {
    return Promise.reject(storageUnavailable());
  }
  exists(): Promise<boolean> {
    return Promise.reject(storageUnavailable());
  }
  stat(): Promise<HrPrivateObjectStat | null> {
    return Promise.reject(storageUnavailable());
  }
}
