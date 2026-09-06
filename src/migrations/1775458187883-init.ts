import { MigrationInterface, QueryRunner } from "typeorm";

export class Init1775458187883 implements MigrationInterface {
    name = 'Init1775458187883'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "employee_region" ("employee_id" integer NOT NULL, "region_id" integer NOT NULL, CONSTRAINT "PK_100d9e88d83df5eee8675be3dc2" PRIMARY KEY ("employee_id", "region_id"))`);
        await queryRunner.query(`CREATE TABLE "region" ("id" SERIAL NOT NULL, "name" character varying NOT NULL, "parentId" integer, "department_id" integer, CONSTRAINT "PK_5f48ffc3af96bc486f5f3f3a6da" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "department" ("id" SERIAL NOT NULL, "name" character varying NOT NULL, "description" character varying, "icon" character varying, CONSTRAINT "UQ_471da4b90e96c1ebe0af221e07b" UNIQUE ("name"), CONSTRAINT "PK_9a2213262c1593bffb581e382f5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "employee" ("id" SERIAL NOT NULL, "name" character varying, "password" character varying, "email" character varying, "phone" character varying, "avatar" character varying, "zalo_user_id" character varying, "isActive" boolean NOT NULL DEFAULT true, "role" character varying NOT NULL DEFAULT 'sales', "department_id" integer, CONSTRAINT "UQ_817d1d427138772d47eca048855" UNIQUE ("email"), CONSTRAINT "UQ_81afb288b526f7e8fed0e4200cc" UNIQUE ("phone"), CONSTRAINT "UQ_7128314c2a25d004e8392794625" UNIQUE ("zalo_user_id"), CONSTRAINT "PK_3c2bc72f03fd5abbbc5ac169498" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7128314c2a25d004e839279462" ON "employee" ("zalo_user_id") `);
        await queryRunner.query(`CREATE TABLE "schools" ("id" SERIAL NOT NULL, "name" character varying NOT NULL, "address" character varying, "representative" character varying, "scale" integer, "tax_code" character varying, "phone" character varying, "employee_id" integer, CONSTRAINT "PK_95b932e47ac129dd8e23a0db548" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."policy_status_enum" AS ENUM('PENDING', 'SALE_ADMIN_APPROVED', 'DIRECTOR_APPROVED', 'REJECTED')`);
        await queryRunner.query(`CREATE TABLE "policy" ("id" SERIAL NOT NULL, "subjectId" integer NOT NULL, "data" json NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "status" "public"."policy_status_enum" NOT NULL DEFAULT 'PENDING', "note" text, "currentHistoryId" integer, CONSTRAINT "PK_9917b0c5e4286703cc656b1d39f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "subjects" ("id" SERIAL NOT NULL, "name" character varying NOT NULL, "code" character varying(50), "school_id" integer NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "student_count" integer NOT NULL DEFAULT '0', "total_lessons" integer NOT NULL DEFAULT '0', "contract_number" character varying(100), "contract_years" integer, "appendix_years" integer, "start_date" date, CONSTRAINT "PK_1a023685ac2b051b4e557b0b280" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "zalo_tokens" ("id" SERIAL NOT NULL, "access_token" text NOT NULL, "refresh_token" text NOT NULL, "expires_in" integer, "expires_at" bigint, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_064a2607f571da5ae71a91bba14" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."policy_history_status_enum" AS ENUM('PENDING', 'SALE_ADMIN_APPROVED', 'DIRECTOR_APPROVED', 'REJECTED')`);
        await queryRunner.query(`CREATE TABLE "policy_history" ("id" SERIAL NOT NULL, "policyId" integer NOT NULL, "updatedBy" character varying, "action" character varying NOT NULL DEFAULT 'UPDATE', "oldData" json, "newData" json, "diff" json, "note" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "status" "public"."policy_history_status_enum" NOT NULL DEFAULT 'PENDING', CONSTRAINT "PK_0c014f4e147cf07835b28d407d3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "employee_region" ADD CONSTRAINT "FK_8d761a31ca2bfd3b1c652492f51" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "employee_region" ADD CONSTRAINT "FK_4a86c5f40a70ddccb062f182fd7" FOREIGN KEY ("region_id") REFERENCES "region"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "region" ADD CONSTRAINT "FK_ed0c8098ce6809925a437f42aec" FOREIGN KEY ("parentId") REFERENCES "region"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "region" ADD CONSTRAINT "FK_d8d786b5acb1a89199ab93f1389" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "employee" ADD CONSTRAINT "FK_d62835db8c0aec1d18a5a927549" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "schools" ADD CONSTRAINT "FK_e7e751fcca0ff95d44066210d41" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "policy" ADD CONSTRAINT "FK_135a3d9b071ee7d5e47b73963a8" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "subjects" ADD CONSTRAINT "FK_07a82eb883094a6990b914cc15e" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "policy_history" ADD CONSTRAINT "FK_4c1f3777155ee4034418cde4fb1" FOREIGN KEY ("policyId") REFERENCES "policy"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "policy_history" DROP CONSTRAINT "FK_4c1f3777155ee4034418cde4fb1"`);
        await queryRunner.query(`ALTER TABLE "subjects" DROP CONSTRAINT "FK_07a82eb883094a6990b914cc15e"`);
        await queryRunner.query(`ALTER TABLE "policy" DROP CONSTRAINT "FK_135a3d9b071ee7d5e47b73963a8"`);
        await queryRunner.query(`ALTER TABLE "schools" DROP CONSTRAINT "FK_e7e751fcca0ff95d44066210d41"`);
        await queryRunner.query(`ALTER TABLE "employee" DROP CONSTRAINT "FK_d62835db8c0aec1d18a5a927549"`);
        await queryRunner.query(`ALTER TABLE "region" DROP CONSTRAINT "FK_d8d786b5acb1a89199ab93f1389"`);
        await queryRunner.query(`ALTER TABLE "region" DROP CONSTRAINT "FK_ed0c8098ce6809925a437f42aec"`);
        await queryRunner.query(`ALTER TABLE "employee_region" DROP CONSTRAINT "FK_4a86c5f40a70ddccb062f182fd7"`);
        await queryRunner.query(`ALTER TABLE "employee_region" DROP CONSTRAINT "FK_8d761a31ca2bfd3b1c652492f51"`);
        await queryRunner.query(`DROP TABLE "policy_history"`);
        await queryRunner.query(`DROP TYPE "public"."policy_history_status_enum"`);
        await queryRunner.query(`DROP TABLE "zalo_tokens"`);
        await queryRunner.query(`DROP TABLE "subjects"`);
        await queryRunner.query(`DROP TABLE "policy"`);
        await queryRunner.query(`DROP TYPE "public"."policy_status_enum"`);
        await queryRunner.query(`DROP TABLE "schools"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7128314c2a25d004e839279462"`);
        await queryRunner.query(`DROP TABLE "employee"`);
        await queryRunner.query(`DROP TABLE "department"`);
        await queryRunner.query(`DROP TABLE "region"`);
        await queryRunner.query(`DROP TABLE "employee_region"`);
    }

}
