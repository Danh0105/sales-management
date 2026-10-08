import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3 (P3-6): `recruitment_channel_events.ai_control_version` — version điều
 * khiển hội thoại lúc lượt AI của event BẮT ĐẦU (ghi bền trước khi gọi OpenClaw).
 *
 * Lượt chạy lại sau crash dựa vào đây: chỉ thao tác của HR (đổi version) mới chặn
 * được lượt đã bắt đầu; tạm dừng do chính lượt đó gây ra (vd. AI mở handoff) thì
 * câu trả lời đã lưu của lượt vẫn được gửi.
 */
export class AddRecruitmentEventAiControlVersion1792400000000 implements MigrationInterface {
  name = 'AddRecruitmentEventAiControlVersion1792400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "recruitment_channel_events" ADD COLUMN "ai_control_version" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "recruitment_channel_events" DROP COLUMN IF EXISTS "ai_control_version"`,
    );
  }
}
