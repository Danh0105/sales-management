import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSchoolGoogleMapsUrl1785700000000 implements MigrationInterface {
    name = 'AddSchoolGoogleMapsUrl1785700000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "google_maps_url" varchar(500)`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "schools" DROP COLUMN IF EXISTS "google_maps_url"`,
        );
    }
}
