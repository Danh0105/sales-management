import { getMetadataArgsStorage } from 'typeorm';

/**
 * Runtime của hệ thống vẫn chạy `synchronize: true` (xem `app.module.ts`).
 * Một entity HR quên `synchronize: false` sẽ bị TypeORM tự CREATE/ALTER trên
 * DB thật ở lần restart kế tiếp — vượt qua toàn bộ quy trình migration.
 *
 * Hàm này kiểm tra các class entity được export từ một file và trả về vi phạm;
 * `hr-entity-guard.spec.ts` chạy nó trên mọi `src/hr/**\/*.entity.ts`.
 */
export function findUnsafeHrEntities(
  exported: Record<string, unknown>,
): string[] {
  const tables = getMetadataArgsStorage().tables;
  const violations: string[] = [];

  for (const [exportName, value] of Object.entries(exported)) {
    if (typeof value !== 'function') continue;
    const table = tables.find((t) => t.target === value);
    if (!table) continue;

    if (table.schema !== 'hr') {
      violations.push(`${exportName}: thiếu schema: 'hr' trong @Entity`);
    }
    if (table.synchronize !== false) {
      violations.push(`${exportName}: thiếu synchronize: false trong @Entity`);
    }
  }

  return violations;
}
