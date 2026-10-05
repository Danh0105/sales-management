import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { HR_PERMISSION_CODES, HR_SCOPES } from './hr-permission';

const MIGRATION = join(
  __dirname,
  '..',
  'migrations',
  '1791700000100-hr-create-access-tables.ts',
);

/**
 * Danh mục quyền trong code và seed trong migration phải khớp: lệch là có mã
 * quyền code dùng mà DB không có (FK fail) hoặc ngược lại.
 */
describe('Danh mục quyền HR', () => {
  const source = readFileSync(MIGRATION, 'utf8');
  const permissionsInsert = source.match(
    /INSERT INTO "hr"\."permissions"[\s\S]*?ON CONFLICT/,
  )![0];

  it('seed hr.permissions (gộp mọi migration HR) khớp đúng enum HrPermission', () => {
    // Quyền mới được seed ở migration sau (không sửa migration đã chạy) —
    // gộp mọi câu INSERT vào hr.permissions trong thư mục migrations.
    const dir = join(__dirname, '..', 'migrations');
    const seeded = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) =>
        [
          ...readFileSync(join(dir, f), 'utf8').matchAll(
            /INSERT INTO "hr"\."permissions"[\s\S]*?ON CONFLICT/g,
          ),
        ].flatMap((insert) =>
          [...insert[0].matchAll(/\('([A-Z_]+)',/g)].map((m) => m[1]),
        ),
      );
    expect(new Set(seeded).size).toBe(seeded.length);
    expect(seeded.sort()).toEqual([...HR_PERMISSION_CODES].sort());
    // Migration gốc vẫn chứa đúng 11 quyền Phase 0.
    expect([...permissionsInsert.matchAll(/\('([A-Z_]+)',/g)]).toHaveLength(11);
  });

  it('CHECK scope trong migration khớp enum HrScope', () => {
    const checks = [...source.matchAll(/CHECK \("scope" IN \(([^)]*)\)\)/g)];
    expect(checks.length).toBe(2);
    for (const [, list] of checks) {
      const values = list.split(',').map((v) => v.trim().replace(/'/g, ''));
      expect(values.sort()).toEqual([...HR_SCOPES].sort());
    }
  });

  it('quyền nhạy cảm không được seed cho role nào', () => {
    const roleInsert = source.match(
      /INSERT INTO "hr"\."role_permissions"[\s\S]*?ON CONFLICT/,
    )![0];
    for (const sensitive of [
      'IDENTITY_REVEAL',
      'BANK_REVEAL',
      'SALARY_VIEW',
      'ACCESS_ADMIN',
    ]) {
      expect(roleInsert).not.toContain(`'${sensitive}'`);
    }
  });
});
