import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  assertApplyAllowed,
  ApplyGuardInput,
  checkMigrationSource,
  findDuplicateTimestamps,
  readDeclaredRisk,
} from './migration-risk';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/** Dựng một migration giả với phần up/down cho trước. */
function migration(
  up: string,
  down = '',
  risk = "'SAFE'",
  ts = '1791700000099',
) {
  return `
    export class HrSample${ts} implements MigrationInterface {
      static readonly risk: MigrationRisk = ${risk};
      async up(q) { ${up} }
      async down(q) { ${down} }
    }`;
}
const FILE = '1791700000099-hr-sample.ts';

describe('HR migration policy — các file thật trong src/hr/migrations', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.ts'));

  it('có ít nhất migration tạo schema', () => {
    expect(files).toContain('1791700000000-hr-create-schema.ts');
  });

  it.each(files)('%s đạt mọi luật an toàn', (file) => {
    const source = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    expect(checkMigrationSource(file, source)).toEqual([]);
  });

  it('không có timestamp trùng', () => {
    expect(findDuplicateTimestamps(files)).toEqual([]);
  });
});

describe('checkMigrationSource', () => {
  it('happy path: CREATE TABLE trong hr + FK tới public.employee', () => {
    const src = migration(
      `q.query('CREATE TABLE IF NOT EXISTS "hr"."employees" ("id" serial, "account_id" int REFERENCES "public"."employee"("id") ON DELETE RESTRICT)')`,
      `q.query('DROP TABLE IF EXISTS "hr"."employees"')`,
    );
    expect(checkMigrationSource(FILE, src)).toEqual([]);
  });

  it.each([
    ['TRUNCATE', `q.query('TRUNCATE "hr"."x"')`, 'TRUNCATE bị cấm'],
    ['DROP SCHEMA', `q.query('DROP SCHEMA "hr"')`, 'DROP SCHEMA bị cấm'],
    [
      'CASCADE',
      `q.query('CREATE TABLE "hr"."x" (a int REFERENCES "hr"."y"(id) ON DELETE CASCADE)')`,
      'CASCADE bị cấm',
    ],
    [
      'ALTER TYPE cột',
      `q.query('ALTER TABLE "hr"."x" ALTER COLUMN "a" TYPE text')`,
      'ALTER COLUMN ... TYPE',
    ],
    [
      'RENAME',
      `q.query('ALTER TABLE "hr"."x" RENAME COLUMN a TO b')`,
      'RENAME bị cấm',
    ],
    [
      'DROP COLUMN',
      `q.query('ALTER TABLE "hr"."x" DROP COLUMN a')`,
      'DROP COLUMN',
    ],
    [
      'DROP TABLE trong up',
      `q.query('DROP TABLE "hr"."x"')`,
      'up() không được DROP',
    ],
    [
      'bảng không có schema',
      `q.query('CREATE TABLE "employees" (id int)')`,
      'CREATE TABLE phải ghi rõ schema hr',
    ],
    [
      'ALTER bảng public',
      `q.query('ALTER TABLE "employee" ADD COLUMN x int')`,
      'ALTER TABLE chỉ được áp',
    ],
    [
      'UPDATE bảng public',
      `q.query('UPDATE "public"."employee" SET name = 1')`,
      'Ghi dữ liệu chỉ được làm',
    ],
    [
      'index trên bảng public',
      `q.query('CREATE INDEX "i" ON "employee" (id)')`,
      'CREATE INDEX chỉ được',
    ],
    [
      'đọc bảng public khác',
      `q.query('INSERT INTO "hr"."x" SELECT * FROM public.payrolls')`,
      'chỉ được tham chiếu public.employee',
    ],
    [
      'UPDATE không schema, có alias',
      `q.query('UPDATE employee e SET name = 1')`,
      'Ghi dữ liệu chỉ được làm',
    ],
    ['TRUNCATE TABLE', `q.query('TRUNCATE TABLE "hr"."x"')`, 'TRUNCATE bị cấm'],
    [
      'function ngoài schema hr',
      `q.query('CREATE OR REPLACE FUNCTION block() RETURNS trigger AS $$ BEGIN RETURN NULL; END $$ LANGUAGE plpgsql')`,
      'FUNCTION phải nằm trong schema hr',
    ],
    [
      'trigger gắn lên bảng public',
      `q.query('CREATE TRIGGER t BEFORE DELETE ON "employee" FOR EACH ROW EXECUTE FUNCTION "hr"."f"()')`,
      'TRIGGER chỉ được gắn',
    ],
  ])('chặn %s', (_label, up, expected) => {
    const violations = checkMigrationSource(FILE, migration(up));
    expect(violations.some((v) => v.includes(expected))).toBe(true);
  });

  it('cho phép trigger append-only trên bảng hr (UPDATE OR DELETE / TRUNCATE ON)', () => {
    const src = migration(
      `q.query('CREATE OR REPLACE FUNCTION "hr"."block"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION USING MESSAGE = TG_OP; END $$ LANGUAGE plpgsql');
       q.query('CREATE OR REPLACE TRIGGER "t_row" BEFORE UPDATE OR DELETE ON "hr"."x" FOR EACH ROW EXECUTE FUNCTION "hr"."block"()');
       q.query('CREATE OR REPLACE TRIGGER "t_stmt" BEFORE TRUNCATE ON "hr"."x" FOR EACH STATEMENT EXECUTE FUNCTION "hr"."block"()');
       q.query('CREATE TABLE "hr"."y" (a int REFERENCES "hr"."x"(id) ON UPDATE NO ACTION)')`,
    );
    expect(checkMigrationSource(FILE, src)).toEqual([]);
  });

  it('down() được DROP TABLE đối tượng hr vừa tạo', () => {
    const src = migration(
      `q.query('CREATE TABLE "hr"."x" (id int)')`,
      `q.query('DROP TABLE IF EXISTS "hr"."x"')`,
    );
    expect(checkMigrationSource(FILE, src)).toEqual([]);
  });

  it('không bắt nhầm chữ trong comment', () => {
    const src = migration(
      `/* không bao giờ DROP SCHEMA hay TRUNCATE */ q.query('CREATE SCHEMA IF NOT EXISTS "hr"')`,
    );
    expect(checkMigrationSource(FILE, src)).toEqual([]);
  });

  it('bắt thiếu nhãn rủi ro và nhãn DANGEROUS', () => {
    const noRisk = migration(`q.query('SELECT 1')`).replace(
      /static readonly risk[^;]*;/,
      '',
    );
    expect(checkMigrationSource(FILE, noRisk).join()).toContain(
      'thiếu `static readonly risk',
    );
    expect(
      checkMigrationSource(
        FILE,
        migration(`q.query('SELECT 1')`, '', "'DANGEROUS'"),
      ).join(),
    ).toContain('DANGEROUS không được');
  });

  it('bắt tên file sai, timestamp cũ, class lệch timestamp', () => {
    const src = migration(`q.query('SELECT 1')`);
    expect(checkMigrationSource('create-hr.ts', src).join()).toContain(
      'tên file',
    );
    expect(
      checkMigrationSource(
        '1780000000000-hr-old.ts',
        migration('', '', "'SAFE'", '1780000000000'),
      ).join(),
    ).toContain('timestamp phải >=');
    expect(
      checkMigrationSource('1791700000100-hr-other.ts', src).join(),
    ).toContain('tên class');
  });

  it('readDeclaredRisk đọc đúng nhãn', () => {
    expect(readDeclaredRisk(migration('', '', "'CAUTION'"))).toBe('CAUTION');
  });
});

describe('findDuplicateTimestamps', () => {
  it('phát hiện hai file trùng timestamp', () => {
    expect(
      findDuplicateTimestamps([
        '1791700000001-hr-a.ts',
        '1791700000001-hr-b.ts',
        '1791700000002-hr-c.ts',
      ]),
    ).toEqual(['1791700000001-hr-a.ts <-> 1791700000001-hr-b.ts']);
  });
});

describe('assertApplyAllowed', () => {
  const base: ApplyGuardInput = {
    apply: true,
    confirmDb: 'sales_db_hr_dev',
    actualDb: 'sales_db_hr_dev',
    nodeEnv: 'development',
    allowProduction: undefined,
    allowCaution: false,
    pending: [{ name: 'HrCreateSchema1791700000000', risk: 'SAFE' }],
  };

  it('happy path: đủ điều kiện thì cho chạy', () => {
    expect(() => assertApplyAllowed(base)).not.toThrow();
  });

  it('không có --apply thì không chạy', () => {
    expect(() => assertApplyAllowed({ ...base, apply: false })).toThrow(
      'dry-run',
    );
  });

  it('thiếu --confirm-db', () => {
    expect(() => assertApplyAllowed({ ...base, confirmDb: undefined })).toThrow(
      'Thiếu --confirm-db',
    );
  });

  it('--confirm-db không khớp DB thật (trỏ nhầm vào sales_db)', () => {
    expect(() => assertApplyAllowed({ ...base, actualDb: 'sales_db' })).toThrow(
      'không khớp',
    );
  });

  it('production cần HR_ALLOW_PRODUCTION_MIGRATION=yes', () => {
    const prod = { ...base, nodeEnv: 'production' };
    expect(() => assertApplyAllowed(prod)).toThrow(
      'HR_ALLOW_PRODUCTION_MIGRATION',
    );
    expect(() =>
      assertApplyAllowed({ ...prod, allowProduction: 'true' }),
    ).toThrow();
    expect(() =>
      assertApplyAllowed({ ...prod, allowProduction: 'yes' }),
    ).not.toThrow();
  });

  it('từ chối DANGEROUS kể cả khi có mọi cờ cho phép', () => {
    const pending = [{ name: 'X1791700000005', risk: 'DANGEROUS' as const }];
    expect(() =>
      assertApplyAllowed({ ...base, pending, allowCaution: true }),
    ).toThrow('DANGEROUS');
  });

  it('từ chối migration thiếu nhãn', () => {
    expect(() =>
      assertApplyAllowed({ ...base, pending: [{ name: 'X', risk: null }] }),
    ).toThrow('thiếu nhãn');
  });

  it('CAUTION cần --allow-caution', () => {
    const pending = [{ name: 'X', risk: 'CAUTION' as const }];
    expect(() => assertApplyAllowed({ ...base, pending })).toThrow(
      '--allow-caution',
    );
    expect(() =>
      assertApplyAllowed({ ...base, pending, allowCaution: true }),
    ).not.toThrow();
  });
});
