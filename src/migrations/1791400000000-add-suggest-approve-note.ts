import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ghi chú chung của Giám đốc/Sales Admin khi duyệt đề xuất chi (đặc biệt hữu
 * ích với đề xuất thiết bị, để nhắc phòng kỹ thuật lưu ý khi lập lệnh xuất kho).
 */
export class AddSuggestApproveNote1791400000000 implements MigrationInterface {
  name = 'AddSuggestApproveNote1791400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "suggest" ADD COLUMN IF NOT EXISTS "approve_note" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP COLUMN IF EXISTS "approve_note"`,
    );
  }
}
