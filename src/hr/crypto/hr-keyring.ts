import { createSecretKey, KeyObject } from 'crypto';
import { inspect } from 'util';
import { HrCryptoConfigError } from './hr-crypto.errors';

/**
 * Keyring có version — nền tảng của key rotation.
 *
 *   HR_ENCRYPTION_ACTIVE_KEY_VERSION=v2
 *   HR_ENCRYPTION_KEY_V1=<base64 32 byte>   ← chỉ còn ĐỌC dữ liệu cũ
 *   HR_ENCRYPTION_KEY_V2=<base64 32 byte>   ← ĐỌC + GHI
 *
 * Ghi luôn dùng active version; đọc dùng key version ghi trong từng payload.
 * Không có biến `HR_ENCRYPTION_KEY` không version.
 *
 * Key giữ trong `KeyObject` (không lộ byte khi inspect), buffer giải mã
 * được xoá về 0 ngay sau khi tạo. `inspect`/`JSON.stringify` keyring chỉ ra
 * danh sách version.
 */

export type HrKeyPurpose = 'encryption' | 'hmac';

export const HR_KEY_BYTES = 32;

const PREFIX: Record<HrKeyPurpose, string> = {
  encryption: 'HR_ENCRYPTION',
  hmac: 'HR_HMAC',
};

/** `v1`, `v2`, … — số nguyên dương, không số 0 đứng đầu. */
export const KEY_VERSION_PATTERN = /^v[1-9]\d{0,5}$/;

/** Base64 chuẩn (RFC 4648 §4), có padding. */
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const activeVersionVar = (purpose: HrKeyPurpose) =>
  `${PREFIX[purpose]}_ACTIVE_KEY_VERSION`;

export const keyVar = (purpose: HrKeyPurpose, version: string) =>
  `${PREFIX[purpose]}_KEY_${version.toUpperCase()}`;

export class HrKeyring {
  readonly #keys: ReadonlyMap<string, KeyObject>;

  constructor(
    readonly purpose: HrKeyPurpose,
    readonly activeVersion: string,
    keys: ReadonlyMap<string, KeyObject>,
  ) {
    if (!keys.has(activeVersion)) {
      throw new HrCryptoConfigError(
        `Active version ${activeVersion} không có key tương ứng.`,
      );
    }
    this.#keys = new Map(keys);
  }

  versions(): string[] {
    return [...this.#keys.keys()].sort(
      (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
    );
  }

  has(version: string): boolean {
    return this.#keys.has(version);
  }

  /** @internal chỉ dùng trong `src/hr/crypto`. `undefined` nếu không có. */
  keyFor(version: string): KeyObject | undefined {
    return this.#keys.get(version);
  }

  /** Hai keyring có dùng chung material nào không (vd. HMAC = encryption). */
  sharesMaterialWith(other: HrKeyring): boolean {
    for (const mine of this.#keys.values()) {
      for (const theirs of other.#keys.values()) {
        if (mine.equals(theirs)) return true;
      }
    }
    return false;
  }

  toJSON() {
    return {
      purpose: this.purpose,
      activeVersion: this.activeVersion,
      versions: this.versions(),
    };
  }

  [inspect.custom]() {
    return `HrKeyring ${JSON.stringify(this.toJSON())}`;
  }
}

/**
 * Đọc + kiểm tra keyring từ biến môi trường. Sai bất kỳ điều gì → ném
 * `HrCryptoConfigError` (chỉ nêu TÊN biến, không nêu giá trị).
 */
export function loadHrKeyring(
  env: NodeJS.ProcessEnv,
  purpose: HrKeyPurpose,
): HrKeyring {
  const prefix = PREFIX[purpose];
  const activeName = activeVersionVar(purpose);
  const keyPrefix = `${prefix}_KEY_`;
  const strictName = new RegExp(`^${prefix}_KEY_V([1-9]\\d{0,5})$`);

  if (env[`${prefix}_KEY`] !== undefined) {
    throw new HrCryptoConfigError(
      `${prefix}_KEY không được hỗ trợ — dùng ${keyPrefix}V1 và ${activeName}=v1.`,
    );
  }

  const keys = new Map<string, KeyObject>();
  const raw: Buffer[] = [];
  try {
    for (const name of Object.keys(env)) {
      if (!name.toUpperCase().startsWith(keyPrefix)) continue;

      const match = strictName.exec(name);
      if (!match) {
        throw new HrCryptoConfigError(
          `Tên biến ${name} không hợp lệ — đúng dạng ${keyPrefix}V<số> (vd. ${keyPrefix}V1), chữ hoa, không số 0 đứng đầu.`,
        );
      }
      const version = `v${match[1]}`;
      if (keys.has(version)) {
        throw new HrCryptoConfigError(`Key version ${version} bị khai trùng.`);
      }

      const bytes = decodeKey(name, env[name]);
      raw.push(bytes);
      if (raw.slice(0, -1).some((other) => other.equals(bytes))) {
        throw new HrCryptoConfigError(
          `${name} trùng material với một key version khác — mỗi version phải là key ngẫu nhiên riêng.`,
        );
      }
      keys.set(version, createSecretKey(bytes));
    }
  } finally {
    for (const bytes of raw) bytes.fill(0);
  }

  const active = env[activeName]?.trim();
  if (!active) {
    throw new HrCryptoConfigError(`Thiếu ${activeName}.`);
  }
  if (!KEY_VERSION_PATTERN.test(active)) {
    throw new HrCryptoConfigError(
      `${activeName} phải có dạng v<số> (vd. v1), không số 0 đứng đầu.`,
    );
  }
  if (!keys.has(active)) {
    throw new HrCryptoConfigError(
      `${activeName} chọn version ${active} nhưng thiếu ${keyVar(purpose, active)}.`,
    );
  }

  return new HrKeyring(purpose, active, keys);
}

function decodeKey(name: string, value: string | undefined): Buffer {
  const text = (value ?? '').trim();
  if (!text) throw new HrCryptoConfigError(`${name} đang để trống.`);
  if (text.length % 4 !== 0 || !BASE64.test(text)) {
    throw new HrCryptoConfigError(`${name} không phải chuỗi Base64 hợp lệ.`);
  }
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== HR_KEY_BYTES) {
    const length = bytes.length;
    bytes.fill(0);
    throw new HrCryptoConfigError(
      `${name} phải giải mã ra đúng ${HR_KEY_BYTES} byte (đang là ${length} byte).`,
    );
  }
  if (bytes.every((b) => b === bytes[0])) {
    bytes.fill(0);
    throw new HrCryptoConfigError(
      `${name} không phải key ngẫu nhiên (mọi byte giống nhau).`,
    );
  }
  return bytes;
}

/** Keyring mã hoá + HMAC dùng lúc khởi động; HMAC không được trùng key mã hoá. */
export function loadHrCryptoKeyrings(env: NodeJS.ProcessEnv): {
  encryption: HrKeyring;
  hmac: HrKeyring;
} {
  const encryption = loadHrKeyring(env, 'encryption');
  const hmac = loadHrKeyring(env, 'hmac');
  if (encryption.sharesMaterialWith(hmac)) {
    throw new HrCryptoConfigError(
      'Một key HR_HMAC_KEY_V* trùng với HR_ENCRYPTION_KEY_V* — hai loại phải sinh riêng.',
    );
  }
  return { encryption, hmac };
}
