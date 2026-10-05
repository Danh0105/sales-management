import { MigrationInterface, QueryRunner } from 'typeorm';

/** Ảnh chụp thiết bị trong kho — dùng hiển thị và in kèm tem QR. */
export class AddWarehouseItemImage1791600000000 implements MigrationInterface {
  name = 'AddWarehouseItemImage1791600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "warehouse_item" ADD COLUMN IF NOT EXISTS "image_url" varchar(255)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "warehouse_item" DROP COLUMN IF EXISTS "image_url"`,
    );
  }
}
