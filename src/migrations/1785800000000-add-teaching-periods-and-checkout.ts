import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTeachingPeriodsAndCheckout1785800000000 implements MigrationInterface {
    name = 'AddTeachingPeriodsAndCheckout1785800000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "teaching_schedules" ADD COLUMN IF NOT EXISTS "periods" integer`,
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "periods" integer`,
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "checkout_at" timestamp`,
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "checkout_latitude" decimal(10,7)`,
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "checkout_longitude" decimal(10,7)`,
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "checkout_accuracy" integer`,
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "checkout_distance" integer`,
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "checkout_out_of_range" boolean DEFAULT false`,
        );

        // Dữ liệu cũ: quy đổi khung giờ theo 45 phút/tiết, giới hạn đúng miền 1..20.
        await queryRunner.query(`
            UPDATE "teaching_schedules"
            SET "periods" = LEAST(20, GREATEST(1,
                CEIL(EXTRACT(EPOCH FROM ("end_time" - "start_time")) / 2700)::integer
            ))
            WHERE "periods" IS NULL
        `);
        await queryRunner.query(`
            UPDATE "teaching_sessions"
            SET "periods" = COALESCE(
                (SELECT s."periods" FROM "teaching_schedules" s
                 WHERE s."id" = "teaching_sessions"."schedule_id"),
                LEAST(20, GREATEST(1,
                    CEIL(EXTRACT(EPOCH FROM ("end_time" - "start_time")) / 2700)::integer
                ))
            )
            WHERE "periods" IS NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "checkout_out_of_range"`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "checkout_distance"`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "checkout_accuracy"`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "checkout_longitude"`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "checkout_latitude"`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "checkout_at"`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "periods"`);
        await queryRunner.query(`ALTER TABLE "teaching_schedules" DROP COLUMN IF EXISTS "periods"`);
    }
}
