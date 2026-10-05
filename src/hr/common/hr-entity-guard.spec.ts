import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { findUnsafeHrEntities } from './hr-entity-guard';

function listEntityFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listEntityFiles(full);
    return name.endsWith('.entity.ts') ? [full] : [];
  });
}

describe('HR entity guard', () => {
  describe('findUnsafeHrEntities', () => {
    it('chấp nhận entity có schema hr và synchronize: false', () => {
      @Entity({ schema: 'hr', name: 'guard_ok', synchronize: false })
      class GuardOk {
        @PrimaryGeneratedColumn() id: number;
      }
      expect(findUnsafeHrEntities({ GuardOk })).toEqual([]);
    });

    it('bắt entity quên synchronize: false — synchronize toàn cục sẽ tự tạo bảng', () => {
      @Entity({ schema: 'hr', name: 'guard_sync' })
      class GuardSync {
        @PrimaryGeneratedColumn() id: number;
      }
      expect(findUnsafeHrEntities({ GuardSync })).toEqual([
        'GuardSync: thiếu synchronize: false trong @Entity',
      ]);
    });

    it('bắt entity rơi vào schema public', () => {
      @Entity({ name: 'guard_public', synchronize: false })
      class GuardPublic {
        @Column() name: string;
      }
      expect(findUnsafeHrEntities({ GuardPublic })).toEqual([
        "GuardPublic: thiếu schema: 'hr' trong @Entity",
      ]);
    });

    it('bỏ qua export không phải entity', () => {
      expect(findUnsafeHrEntities({ helper: () => 1, CONST: 'x' })).toEqual([]);
    });
  });

  it('mọi entity trong src/hr đều có schema hr và synchronize: false', () => {
    const files = listEntityFiles(join(__dirname, '..'));
    const violations = files.flatMap((file) =>
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      findUnsafeHrEntities(require(file) as Record<string, unknown>).map(
        (v) => `${file}: ${v}`,
      ),
    );
    expect(violations).toEqual([]);
  });
});
