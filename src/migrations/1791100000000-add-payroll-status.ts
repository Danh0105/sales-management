import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phiếu lương giờ tạo ở trạng thái nháp — nhân viên chỉ thấy phiếu của mình
 * sau khi người lập bấm "Gửi phiếu lương". Runtime hiện còn `synchronize:
 * true`; migration này dùng cho môi trường tắt đồng bộ schema tự động.
 */
export class AddPayrollStatus1791100000000 implements MigrationInterface {
  name = 'AddPayrollStatus1791100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "payrolls_status_enum" AS ENUM ('DRAFT', 'SENT');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "payrolls"
      ADD COLUMN IF NOT EXISTS "status" "payrolls_status_enum" NOT NULL DEFAULT 'DRAFT',
      ADD COLUMN IF NOT EXISTS "sent_at" TIMESTAMP,
      ADD COLUMN IF NOT EXISTS "sent_by_id" integer,
      ADD COLUMN IF NOT EXISTS "sent_by_name" character varying(255)
    `);

    // Phiếu đã có từ trước khi migration này chạy: coi như đã gửi, tránh
    // ẩn mất phiếu mà nhân viên đang xem được.
    await queryRunner.query(`
      UPDATE "payrolls" SET "status" = 'SENT', "sent_at" = "created_at"
      WHERE "status" = 'DRAFT'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payrolls"
      DROP COLUMN IF EXISTS "status",
      DROP COLUMN IF EXISTS "sent_at",
      DROP COLUMN IF EXISTS "sent_by_id",
      DROP COLUMN IF EXISTS "sent_by_name"
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS "payrolls_status_enum"`);
  }
}
