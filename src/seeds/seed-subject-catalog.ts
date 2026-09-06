/**
 * Nạp danh mục môn học từ dữ liệu môn học đã tạo trước đây.
 *
 *   - Gom mọi tên môn đang có trong bảng `subjects` (bỏ khoảng trắng thừa,
 *     không phân biệt hoa/thường) → mỗi tên thành 1 dòng trong `subject_catalogs`.
 *     Biến thể được dùng nhiều nhất là tên chuẩn (VD: "STEM" thay vì "Stem"/"stem").
 *   - Map `subjects.catalog_id` về đúng môn trong danh mục.
 *
 * Chạy được nhiều lần (idempotent): môn đã có trong danh mục sẽ không bị tạo lại,
 * môn học đã map catalog_id sẽ không bị đụng tới.
 *
 * Chạy: npm run seed:subject-catalog
 * (bảng `subject_catalogs` và cột `subjects.catalog_id` do TypeORM synchronize
 *  tạo khi app khởi động — deploy backend trước rồi mới chạy seed)
 */
import { Client } from 'pg';

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

/** Biểu thức chuẩn hoá tên môn dùng chung cho cả insert lẫn map. */
const CLEAN_NAME = `btrim(regexp_replace(subjects."name", '\\s+', ' ', 'g'))`;

async function main() {
    const client = new Client(DB);
    await client.connect();

    try {
        const schema = await client.query(`
            SELECT
                to_regclass('public.subject_catalogs') IS NOT NULL AS has_table,
                EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'subjects' AND column_name = 'catalog_id'
                ) AS has_column
        `);

        if (!schema.rows[0].has_table || !schema.rows[0].has_column) {
            throw new Error(
                'Chưa có bảng "subject_catalogs" hoặc cột "subjects.catalog_id". ' +
                'Hãy deploy/khởi động backend mới một lần (TypeORM synchronize sẽ tạo) rồi chạy lại seed.',
            );
        }

        await client.query('BEGIN');

        const inserted = await client.query(`
            WITH cleaned AS (
                SELECT ${CLEAN_NAME} AS clean_name, COUNT(*) AS uses
                FROM subjects
                WHERE subjects."name" IS NOT NULL
                  AND btrim(subjects."name") <> ''
                GROUP BY 1
            ),
            canonical AS (
                SELECT DISTINCT ON (LOWER(clean_name)) clean_name
                FROM cleaned
                ORDER BY LOWER(clean_name), uses DESC, clean_name ASC
            )
            INSERT INTO subject_catalogs ("name", is_active, sort_order)
            SELECT canonical.clean_name, true, 0
            FROM canonical
            WHERE NOT EXISTS (
                SELECT 1 FROM subject_catalogs existing
                WHERE LOWER(existing."name") = LOWER(canonical.clean_name)
            )
            RETURNING id, "name"
        `);

        const mapped = await client.query(`
            UPDATE subjects
            SET catalog_id = catalog.id
            FROM subject_catalogs AS catalog
            WHERE subjects.catalog_id IS NULL
              AND LOWER(${CLEAN_NAME}) = LOWER(catalog."name")
            RETURNING subjects.id
        `);

        await client.query('COMMIT');

        const summary = await client.query(`
            SELECT
                (SELECT COUNT(*) FROM subject_catalogs) AS catalog_total,
                (SELECT COUNT(*) FROM subjects WHERE catalog_id IS NOT NULL) AS linked,
                (SELECT COUNT(*) FROM subjects WHERE catalog_id IS NULL) AS unlinked
        `);

        const { catalog_total, linked, unlinked } = summary.rows[0];

        for (const row of inserted.rows) {
            console.log(`+ Thêm vào danh mục: "${row.name}" (id=${row.id})`);
        }

        console.log(
            `\n✓ Danh mục môn học: ${catalog_total} môn ` +
            `(vừa thêm ${inserted.rowCount})`,
        );
        console.log(
            `✓ Môn học của trường: ${linked} đã gắn danh mục ` +
            `(vừa gắn ${mapped.rowCount}), ${unlinked} chưa gắn`,
        );
        console.log(
            '\nSales admin nên vào màn "Danh mục môn học" để tắt (is_active=false) ' +
            'các môn nhập sai/thử nghiệm — dữ liệu môn học cũ vẫn giữ nguyên.',
        );
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error('Seed thất bại:', err);
    process.exit(1);
});
