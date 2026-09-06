import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSchoolLocationAndSessionCheckin1785600000000 implements MigrationInterface {
    name = 'AddSchoolLocationAndSessionCheckin1785600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "latitude" decimal(10,7)`);
        await queryRunner.query(`ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "longitude" decimal(10,7)`);
        await queryRunner.query(`ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "checkin_radius" integer`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "checkin_at" timestamp`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "checkin_latitude" decimal(10,7)`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "checkin_longitude" decimal(10,7)`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "checkin_accuracy" integer`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "checkin_distance" integer`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "checkin_out_of_range" boolean DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "checkin_out_of_range"`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "checkin_distance"`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "checkin_accuracy"`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "checkin_longitude"`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "checkin_latitude"`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "checkin_at"`);
        await queryRunner.query(`ALTER TABLE "schools" DROP COLUMN IF EXISTS "checkin_radius"`);
        await queryRunner.query(`ALTER TABLE "schools" DROP COLUMN IF EXISTS "longitude"`);
        await queryRunner.query(`ALTER TABLE "schools" DROP COLUMN IF EXISTS "latitude"`);
    }
}
