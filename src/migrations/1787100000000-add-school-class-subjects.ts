import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSchoolClassSubjects1787100000000 implements MigrationInterface {
    name = 'AddSchoolClassSubjects1787100000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "school_class_subjects" (
            "class_id" integer NOT NULL,
            "subject_id" integer NOT NULL,
            CONSTRAINT "PK_school_class_subjects" PRIMARY KEY ("class_id", "subject_id"),
            CONSTRAINT "FK_school_class_subjects_class" FOREIGN KEY ("class_id")
                REFERENCES "school_classes"("id") ON DELETE CASCADE,
            CONSTRAINT "FK_school_class_subjects_subject" FOREIGN KEY ("subject_id")
                REFERENCES "subjects"("id") ON DELETE CASCADE
        )`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_school_class_subjects_subject"
            ON "school_class_subjects" ("subject_id")`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('DROP TABLE IF EXISTS "school_class_subjects"');
    }
}
