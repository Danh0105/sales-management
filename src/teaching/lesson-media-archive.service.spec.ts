import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LessonMediaArchiveService } from './lesson-media-archive.service';

const NAME = '00000000-0000-4000-8000-000000000001.webp';

function make(env: Record<string, string>) {
  return new LessonMediaArchiveService({
    get: (key: string) => env[key],
  } as never);
}

describe('LessonMediaArchiveService', () => {
  let local: string;
  let archive: string;

  beforeEach(async () => {
    local = await mkdtemp(join(tmpdir(), 'lm-local-'));
    archive = await mkdtemp(join(tmpdir(), 'lm-archive-'));
    await mkdir(join(local, 'thumb'));
  });
  afterEach(async () => {
    await rm(local, { recursive: true, force: true });
    await rm(archive, { recursive: true, force: true });
  });

  it('ưu tiên bản local', async () => {
    await writeFile(join(local, NAME), 'x');
    await writeFile(join(archive, NAME), 'y');
    const s = make({ LESSON_IMAGE_UPLOAD_DIR: local, LESSON_IMAGE_ARCHIVE_DIR: archive });
    expect(await s.locate(NAME)).toEqual({ path: join(local, NAME), tier: 'local' });
  });

  it('rơi xuống NAS khi local không có', async () => {
    await writeFile(join(archive, NAME), 'y');
    const s = make({ LESSON_IMAGE_UPLOAD_DIR: local, LESSON_IMAGE_ARCHIVE_DIR: archive });
    expect(await s.locate(NAME)).toEqual({ path: join(archive, NAME), tier: 'archive' });
  });

  it('không cấu hình NAS thì chỉ tra local', async () => {
    await writeFile(join(archive, NAME), 'y');
    const s = make({ LESSON_IMAGE_UPLOAD_DIR: local });
    expect(await s.locate(NAME)).toBeNull();
  });

  it('chặn path traversal', async () => {
    const s = make({ LESSON_IMAGE_UPLOAD_DIR: local, LESSON_IMAGE_ARCHIVE_DIR: archive });
    expect(await s.locate('../../etc/passwd')).toBeNull();
    expect(await s.locate('a.webp')).toBeNull();
    expect(await s.locateThumbnail('../x.webp')).toBeNull();
  });

  it('NAS quá hạn → ngắt breaker, lần sau không chạm NAS nữa', async () => {
    const s = make({
      LESSON_IMAGE_UPLOAD_DIR: local,
      LESSON_IMAGE_ARCHIVE_DIR: archive,
      LESSON_IMAGE_ARCHIVE_TIMEOUT_MS: '20',
      LESSON_IMAGE_ARCHIVE_COOLDOWN_MS: '10000',
    });
    // Giả lập NFS treo: `exists` không bao giờ trả về.
    const hang = jest
      .spyOn(s as never, 'exists')
      .mockImplementation(async (p: string) =>
        p.startsWith(archive) ? new Promise<boolean>(() => {}) : false,
      );

    expect(await s.locate(NAME)).toBeNull();
    expect(s.archiveAvailable()).toBe(false);
    expect(s.status().failures).toBe(1);

    const calls = hang.mock.calls.length;
    expect(await s.locate(NAME)).toBeNull();
    // Chỉ thêm đúng 1 lần gọi (kiểm tra local) — không đụng NAS.
    expect(hang.mock.calls.length).toBe(calls + 1);
  });

  it('thumbnail luôn tra ở local', async () => {
    await writeFile(join(local, 'thumb', NAME), 't');
    const s = make({ LESSON_IMAGE_UPLOAD_DIR: local, LESSON_IMAGE_ARCHIVE_DIR: archive });
    expect(await s.locateThumbnail(NAME)).toBe(join(local, 'thumb', NAME));
    expect(await s.locateThumbnail(NAME.replace('.webp', '.mp4'))).toBe(
      join(local, 'thumb', NAME),
    );
  });
});
