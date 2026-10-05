import { mkdtempSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { newStorageKey, STORAGE_KEY_PATTERN } from './hr-private-storage';
import {
  LocalHrPrivateStorage,
  validateStorageRoot,
} from './local-hr-private-storage';

const silent = { log: () => undefined, warn: jest.fn() };

describe('validateStorageRoot — không nằm trong / chứa thư mục static', () => {
  const project = resolve('/srv/app');

  it.each([
    [undefined, 'thiếu'],
    ['relative/dir', 'tuyệt đối'],
    [resolve('/srv/app/uploads/hr'), 'serve tĩnh'],
    [resolve('/srv/app/uploads'), 'serve tĩnh'],
    [resolve('/srv/app/public/x'), 'serve tĩnh'],
    [resolve('/srv/app/dist/hr'), 'serve tĩnh'],
    [resolve('/srv/app'), 'serve tĩnh'], // chứa uploads
    [resolve('/srv'), 'serve tĩnh'],
  ])('[8] %s → từ chối', (dir, reason) => {
    const r = validateStorageRoot(dir, project);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain(reason);
  });

  it('thư mục riêng ngoài project → hợp lệ', () => {
    expect(
      validateStorageRoot(resolve('/var/lib/sales/hr-private'), project),
    ).toEqual({
      ok: true,
      root: resolve('/var/lib/sales/hr-private'),
    });
  });

  it('cấu hình sai → adapter UNAVAILABLE, log không in đường dẫn', () => {
    const warn = jest.fn();
    const storage = LocalHrPrivateStorage.fromEnv(
      { HR_PRIVATE_STORAGE_DIR: resolve('/srv/app/uploads/hr') },
      project,
      { log: () => undefined, warn },
    );
    expect(storage.available).toBe(false);
    expect(String(warn.mock.calls[0][0])).not.toContain('uploads');
  });
});

describe('LocalHrPrivateStorage', () => {
  let root: string;
  let storage: LocalHrPrivateStorage;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hr-private-'));
    storage = LocalHrPrivateStorage.fromEnv(
      { HR_PRIVATE_STORAGE_DIR: root },
      resolve('/srv/app'),
      silent,
    ) as LocalHrPrivateStorage;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const meta = { contentType: 'application/pdf', sha256: 'x' };

  it('[12] put / exists / stat / openRead / delete', async () => {
    const key = newStorageKey();
    await storage.put(key, Buffer.from('%PDF-abc'), meta);
    expect(await storage.exists(key)).toBe(true);
    expect(await storage.stat(key)).toEqual({ sizeBytes: 8 });
    const chunks: Buffer[] = [];
    for await (const c of await storage.openRead(key)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('%PDF-abc');
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
    await expect(storage.delete(key)).resolves.toBeUndefined(); // idempotent
  });

  it('[20] không ghi đè object đã có', async () => {
    const key = newStorageKey();
    await storage.put(key, Buffer.from('first'), meta);
    await expect(
      storage.put(key, Buffer.from('second'), meta),
    ).rejects.toThrow();
    expect(await storage.stat(key)).toEqual({ sizeBytes: 5 });
  });

  it.each([
    '../../etc/passwd',
    '..\\..\\secret',
    '%2e%2e/x',
    'ab/../../x',
    'AB/0000',
    '',
  ])('[19] key sai dạng %j → từ chối, không đụng filesystem', async (key) => {
    expect(() => storage.pathFor(key)).toThrow('Storage key không hợp lệ');
    await expect(storage.put(key, Buffer.from('x'), meta)).rejects.toThrow();
  });

  it('[6] key luôn ngẫu nhiên, đúng dạng, nằm trong thư mục gốc', () => {
    const keys = new Set(Array.from({ length: 1000 }, () => newStorageKey()));
    expect(keys.size).toBe(1000);
    for (const k of keys) {
      expect(k).toMatch(STORAGE_KEY_PATTERN);
      expect(storage.pathFor(k).startsWith(root)).toBe(true);
    }
  });

  it('không hỗ trợ signed URL → service dùng token endpoint', async () => {
    expect(storage.supportsSignedUrls).toBe(false);
    await expect(storage.getSignedReadUrl()).rejects.toThrow('token endpoint');
  });

  it('file được tạo mode 0600 (POSIX)', async () => {
    const key = newStorageKey();
    await storage.put(key, Buffer.from('x'), meta);
    const mode = statSync(storage.pathFor(key)).mode & 0o777;
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
    expect(readdirSync(root)).toEqual([key.slice(0, 2)]);
  });
});
