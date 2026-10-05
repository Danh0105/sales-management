import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module Tuyển dụng (Phase 1): vị trí tuyển, ứng viên, hồ sơ ứng tuyển, hội
 * thoại, slot/lịch phỏng vấn, chuyển HR và khoá idempotency cho API AI.
 *
 * Production đang chạy `synchronize: true` nên file này **không được chạy** —
 * nó là bản mô tả schema chính xác mà các entity trong `src/recruitment`
 * phải khớp (tên enum, PK, FK, index, check đều đặt tường minh). Viết
 * `IF NOT EXISTS` để vẫn chạy an toàn nếu sau này chuyển sang migration khi
 * synchronize đã tạo bảng trước.
 */
export class CreateRecruitment1791800000000 implements MigrationInterface {
  name = 'CreateRecruitment1791800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const createEnum = (name: string, values: string[]) =>
      queryRunner.query(`DO $$ BEGIN
        CREATE TYPE "public"."${name}" AS ENUM(${values.map((v) => `'${v}'`).join(', ')});
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

    const SOURCES = [
      'ZALO',
      'WEBSITE',
      'FACEBOOK',
      'REFERRAL',
      'MANUAL',
      'OTHER',
    ];
    const ACTOR_TYPES = ['AI', 'HR', 'SYSTEM'];

    await createEnum('recruitment_jobs_employment_type_enum', [
      'FULL_TIME',
      'PART_TIME',
      'CONTRACT',
      'INTERNSHIP',
      'COLLABORATOR',
    ]);
    await createEnum('recruitment_jobs_status_enum', [
      'DRAFT',
      'ACTIVE',
      'PAUSED',
      'CLOSED',
    ]);
    await createEnum('recruitment_candidates_source_enum', SOURCES);
    await createEnum('recruitment_applications_status_enum', [
      'NEW',
      'COLLECTING_INFO',
      'SCREENING',
      'QUALIFIED',
      'NEEDS_HR_REVIEW',
      'INTERVIEW',
      'OFFER',
      'HIRED',
      'REJECTED',
      'WITHDRAWN',
    ]);
    await createEnum('recruitment_applications_source_enum', SOURCES);
    await createEnum('recruitment_applications_ai_match_level_enum', [
      'HIGH_MATCH',
      'MEDIUM_MATCH',
      'LOW_MATCH',
      'INSUFFICIENT_DATA',
    ]);
    await createEnum('recruitment_conversations_channel_enum', [
      'ZALO',
      'WEB',
      'FACEBOOK',
      'OTHER',
    ]);
    await createEnum('recruitment_conversations_status_enum', [
      'ACTIVE',
      'CLOSED',
    ]);
    await createEnum('recruitment_messages_sender_type_enum', [
      'CANDIDATE',
      'AI',
      'HR',
      'SYSTEM',
    ]);
    await createEnum('recruitment_messages_direction_enum', [
      'INBOUND',
      'OUTBOUND',
    ]);
    await createEnum('recruitment_messages_content_type_enum', [
      'TEXT',
      'IMAGE',
      'FILE',
      'LINK',
      'OTHER',
    ]);
    await createEnum('recruitment_interviews_status_enum', [
      'PROPOSED',
      'CONFIRMED',
      'COMPLETED',
      'CANCELLED',
      'NO_SHOW',
    ]);
    await createEnum(
      'recruitment_interviews_created_by_type_enum',
      ACTOR_TYPES,
    );
    await createEnum('recruitment_handoffs_reason_enum', [
      'CANDIDATE_REQUESTED_HUMAN',
      'SALARY_OUT_OF_RANGE',
      'AI_UNCERTAIN',
      'COMPLAINT',
      'DATA_DELETION_REQUEST',
      'SPECIAL_CASE',
      'FINAL_DECISION_REQUIRED',
      'OTHER',
    ]);
    await createEnum('recruitment_handoffs_priority_enum', [
      'LOW',
      'NORMAL',
      'HIGH',
      'URGENT',
    ]);
    await createEnum('recruitment_handoffs_status_enum', [
      'OPEN',
      'RESOLVED',
      'RETURNED_TO_AI',
    ]);
    await createEnum(
      'recruitment_handoffs_requested_by_type_enum',
      ACTOR_TYPES,
    );
    await createEnum('recruitment_ai_idempotency_keys_status_enum', [
      'IN_PROGRESS',
      'COMPLETED',
    ]);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "recruitment_jobs" (
      "id" SERIAL NOT NULL,
      "code" character varying(50) NOT NULL,
      "title" character varying(255) NOT NULL,
      "description" text,
      "department_id" integer,
      "location" character varying(255),
      "employment_type" "public"."recruitment_jobs_employment_type_enum" NOT NULL DEFAULT 'FULL_TIME',
      "number_of_positions" integer NOT NULL DEFAULT 1,
      "salary_min" numeric(15,2),
      "salary_max" numeric(15,2),
      "currency" character varying(3) NOT NULL DEFAULT 'VND',
      "requirements" text,
      "responsibilities" text,
      "screening_criteria" jsonb NOT NULL DEFAULT '{}',
      "status" "public"."recruitment_jobs_status_enum" NOT NULL DEFAULT 'DRAFT',
      "published_at" TIMESTAMP WITH TIME ZONE,
      "closed_at" TIMESTAMP WITH TIME ZONE,
      "created_by" integer,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_recruitment_jobs" PRIMARY KEY ("id"),
      CONSTRAINT "CHK_recruitment_jobs_positions" CHECK ("number_of_positions" > 0),
      CONSTRAINT "CHK_recruitment_jobs_salary" CHECK (("salary_min" IS NULL OR "salary_min" >= 0) AND ("salary_max" IS NULL OR "salary_max" >= 0) AND ("salary_min" IS NULL OR "salary_max" IS NULL OR "salary_min" <= "salary_max")),
      CONSTRAINT "FK_recruitment_jobs_department" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
      CONSTRAINT "FK_recruitment_jobs_created_by" FOREIGN KEY ("created_by") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE NO ACTION
    )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_recruitment_jobs_code" ON "recruitment_jobs" ("code")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recruitment_jobs_status" ON "recruitment_jobs" ("status")`,
    );

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "recruitment_candidates" (
      "id" SERIAL NOT NULL,
      "full_name" character varying(255),
      "phone" character varying(20),
      "email" character varying(255),
      "zalo_user_id" character varying(100),
      "source" "public"."recruitment_candidates_source_enum" NOT NULL DEFAULT 'MANUAL',
      "location" character varying(255),
      "education" character varying(500),
      "experience_summary" text,
      "total_experience_months" integer,
      "current_job" character varying(255),
      "expected_salary" numeric(15,2),
      "available_from" date,
      "skills" text array NOT NULL DEFAULT '{}',
      "cv_url" character varying(1000),
      "notes" text,
      "metadata" jsonb NOT NULL DEFAULT '{}',
      "suspected_duplicate_ids" integer array NOT NULL DEFAULT '{}',
      "deletion_requested_at" TIMESTAMP WITH TIME ZONE,
      "ai_stopped_at" TIMESTAMP WITH TIME ZONE,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_recruitment_candidates" PRIMARY KEY ("id"),
      CONSTRAINT "CHK_recruitment_candidates_experience" CHECK ("total_experience_months" IS NULL OR "total_experience_months" >= 0),
      CONSTRAINT "CHK_recruitment_candidates_salary" CHECK ("expected_salary" IS NULL OR "expected_salary" >= 0)
    )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_recruitment_candidates_zalo_user_id" ON "recruitment_candidates" ("zalo_user_id") WHERE "zalo_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recruitment_candidates_phone" ON "recruitment_candidates" ("phone")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recruitment_candidates_email" ON "recruitment_candidates" ("email")`,
    );

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "recruitment_applications" (
      "id" SERIAL NOT NULL,
      "candidate_id" integer NOT NULL,
      "job_id" integer NOT NULL,
      "status" "public"."recruitment_applications_status_enum" NOT NULL DEFAULT 'NEW',
      "source" "public"."recruitment_applications_source_enum" NOT NULL DEFAULT 'MANUAL',
      "ai_match_score" smallint,
      "ai_match_level" "public"."recruitment_applications_ai_match_level_enum",
      "ai_summary" text,
      "ai_strengths" jsonb NOT NULL DEFAULT '[]',
      "ai_concerns" jsonb NOT NULL DEFAULT '[]',
      "ai_missing_information" jsonb NOT NULL DEFAULT '[]',
      "ai_score_breakdown" jsonb,
      "screening_completed_at" TIMESTAMP WITH TIME ZONE,
      "ai_paused" boolean NOT NULL DEFAULT false,
      "hr_reviewed_at" TIMESTAMP WITH TIME ZONE,
      "reviewed_by" integer,
      "rejected_reason" text,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_recruitment_applications" PRIMARY KEY ("id"),
      CONSTRAINT "CHK_recruitment_applications_score" CHECK ("ai_match_score" IS NULL OR ("ai_match_score" >= 0 AND "ai_match_score" <= 100)),
      CONSTRAINT "FK_recruitment_applications_candidate" FOREIGN KEY ("candidate_id") REFERENCES "recruitment_candidates"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
      CONSTRAINT "FK_recruitment_applications_job" FOREIGN KEY ("job_id") REFERENCES "recruitment_jobs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
      CONSTRAINT "FK_recruitment_applications_reviewed_by" FOREIGN KEY ("reviewed_by") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE NO ACTION
    )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recruitment_applications_candidate" ON "recruitment_applications" ("candidate_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recruitment_applications_job" ON "recruitment_applications" ("job_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recruitment_applications_status" ON "recruitment_applications" ("status")`,
    );
    // Mỗi ứng viên chỉ có một hồ sơ còn hiệu lực cho một vị trí; bị loại hoặc
    // rút hồ sơ thì được ứng tuyển lại.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_recruitment_applications_active" ON "recruitment_applications" ("candidate_id", "job_id") WHERE "status" NOT IN ('REJECTED', 'WITHDRAWN')`,
    );

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "recruitment_conversations" (
      "id" SERIAL NOT NULL,
      "candidate_id" integer NOT NULL,
      "application_id" integer,
      "channel" "public"."recruitment_conversations_channel_enum" NOT NULL,
      "external_conversation_id" character varying(255),
      "status" "public"."recruitment_conversations_status_enum" NOT NULL DEFAULT 'ACTIVE',
      "last_message_at" TIMESTAMP WITH TIME ZONE,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_recruitment_conversations" PRIMARY KEY ("id"),
      CONSTRAINT "FK_recruitment_conversations_candidate" FOREIGN KEY ("candidate_id") REFERENCES "recruitment_candidates"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
      CONSTRAINT "FK_recruitment_conversations_application" FOREIGN KEY ("application_id") REFERENCES "recruitment_applications"("id") ON DELETE SET NULL ON UPDATE NO ACTION
    )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recruitment_conversations_candidate" ON "recruitment_conversations" ("candidate_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_recruitment_conversations_external" ON "recruitment_conversations" ("channel", "external_conversation_id") WHERE "external_conversation_id" IS NOT NULL`,
    );

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "recruitment_messages" (
      "id" SERIAL NOT NULL,
      "conversation_id" integer NOT NULL,
      "external_message_id" character varying(255),
      "sender_type" "public"."recruitment_messages_sender_type_enum" NOT NULL,
      "direction" "public"."recruitment_messages_direction_enum" NOT NULL,
      "content" text NOT NULL,
      "content_type" "public"."recruitment_messages_content_type_enum" NOT NULL DEFAULT 'TEXT',
      "metadata" jsonb NOT NULL DEFAULT '{}',
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_recruitment_messages" PRIMARY KEY ("id"),
      CONSTRAINT "FK_recruitment_messages_conversation" FOREIGN KEY ("conversation_id") REFERENCES "recruitment_conversations"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recruitment_messages_conversation_created" ON "recruitment_messages" ("conversation_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_recruitment_messages_external" ON "recruitment_messages" ("conversation_id", "external_message_id") WHERE "external_message_id" IS NOT NULL`,
    );

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "recruitment_interview_slots" (
      "id" SERIAL NOT NULL,
      "job_id" integer,
      "interviewer_id" integer,
      "start_at" TIMESTAMP WITH TIME ZONE NOT NULL,
      "end_at" TIMESTAMP WITH TIME ZONE NOT NULL,
      "timezone" character varying(64) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
      "location" character varying(500),
      "meeting_url" character varying(1000),
      "capacity" integer NOT NULL DEFAULT 1,
      "booked_count" integer NOT NULL DEFAULT 0,
      "is_active" boolean NOT NULL DEFAULT true,
      "notes" text,
      "created_by" integer,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_recruitment_interview_slots" PRIMARY KEY ("id"),
      CONSTRAINT "CHK_recruitment_interview_slots_time" CHECK ("end_at" > "start_at"),
      CONSTRAINT "CHK_recruitment_interview_slots_capacity" CHECK ("capacity" >= 1 AND "booked_count" >= 0 AND "booked_count" <= "capacity"),
      CONSTRAINT "FK_recruitment_interview_slots_job" FOREIGN KEY ("job_id") REFERENCES "recruitment_jobs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
      CONSTRAINT "FK_recruitment_interview_slots_interviewer" FOREIGN KEY ("interviewer_id") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
      CONSTRAINT "FK_recruitment_interview_slots_created_by" FOREIGN KEY ("created_by") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE NO ACTION
    )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recruitment_interview_slots_start" ON "recruitment_interview_slots" ("start_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recruitment_interview_slots_job" ON "recruitment_interview_slots" ("job_id")`,
    );

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "recruitment_interviews" (
      "id" SERIAL NOT NULL,
      "application_id" integer NOT NULL,
      "candidate_id" integer NOT NULL,
      "job_id" integer NOT NULL,
      "slot_id" integer,
      "interviewer_id" integer,
      "scheduled_start" TIMESTAMP WITH TIME ZONE NOT NULL,
      "scheduled_end" TIMESTAMP WITH TIME ZONE NOT NULL,
      "timezone" character varying(64) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
      "location" character varying(500),
      "meeting_url" character varying(1000),
      "status" "public"."recruitment_interviews_status_enum" NOT NULL DEFAULT 'PROPOSED',
      "candidate_confirmed_at" TIMESTAMP WITH TIME ZONE,
      "cancelled_at" TIMESTAMP WITH TIME ZONE,
      "cancellation_reason" text,
      "notes" text,
      "created_by_type" "public"."recruitment_interviews_created_by_type_enum" NOT NULL,
      "created_by" integer,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_recruitment_interviews" PRIMARY KEY ("id"),
      CONSTRAINT "CHK_recruitment_interviews_time" CHECK ("scheduled_end" > "scheduled_start"),
      CONSTRAINT "FK_recruitment_interviews_application" FOREIGN KEY ("application_id") REFERENCES "recruitment_applications"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
      CONSTRAINT "FK_recruitment_interviews_candidate" FOREIGN KEY ("candidate_id") REFERENCES "recruitment_candidates"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
      CONSTRAINT "FK_recruitment_interviews_job" FOREIGN KEY ("job_id") REFERENCES "recruitment_jobs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
      CONSTRAINT "FK_recruitment_interviews_slot" FOREIGN KEY ("slot_id") REFERENCES "recruitment_interview_slots"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
      CONSTRAINT "FK_recruitment_interviews_interviewer" FOREIGN KEY ("interviewer_id") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
      CONSTRAINT "FK_recruitment_interviews_created_by" FOREIGN KEY ("created_by") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE NO ACTION
    )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recruitment_interviews_application" ON "recruitment_interviews" ("application_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recruitment_interviews_scheduled_start" ON "recruitment_interviews" ("scheduled_start")`,
    );
    // Một hồ sơ chỉ có một lịch đang chờ/đã xác nhận; vòng sau tạo khi vòng trước đã xong.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_recruitment_interviews_active" ON "recruitment_interviews" ("application_id") WHERE "status" IN ('PROPOSED', 'CONFIRMED')`,
    );

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "recruitment_handoffs" (
      "id" SERIAL NOT NULL,
      "candidate_id" integer NOT NULL,
      "application_id" integer,
      "reason" "public"."recruitment_handoffs_reason_enum" NOT NULL,
      "priority" "public"."recruitment_handoffs_priority_enum" NOT NULL DEFAULT 'NORMAL',
      "summary" text NOT NULL,
      "status" "public"."recruitment_handoffs_status_enum" NOT NULL DEFAULT 'OPEN',
      "requested_by_type" "public"."recruitment_handoffs_requested_by_type_enum" NOT NULL,
      "requested_by" integer,
      "resolved_by" integer,
      "resolved_at" TIMESTAMP WITH TIME ZONE,
      "resolution_note" text,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_recruitment_handoffs" PRIMARY KEY ("id"),
      CONSTRAINT "FK_recruitment_handoffs_candidate" FOREIGN KEY ("candidate_id") REFERENCES "recruitment_candidates"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
      CONSTRAINT "FK_recruitment_handoffs_application" FOREIGN KEY ("application_id") REFERENCES "recruitment_applications"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
      CONSTRAINT "FK_recruitment_handoffs_requested_by" FOREIGN KEY ("requested_by") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
      CONSTRAINT "FK_recruitment_handoffs_resolved_by" FOREIGN KEY ("resolved_by") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE NO ACTION
    )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recruitment_handoffs_status_created" ON "recruitment_handoffs" ("status", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recruitment_handoffs_candidate" ON "recruitment_handoffs" ("candidate_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recruitment_handoffs_application" ON "recruitment_handoffs" ("application_id")`,
    );
    // Retry cùng lý do không đẻ thêm yêu cầu; lý do khác (vd. xoá dữ liệu sau
    // khiếu nại lương) vẫn mở được yêu cầu riêng.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_recruitment_handoffs_open_reason" ON "recruitment_handoffs" ("application_id", "reason") WHERE "status" = 'OPEN'`,
    );

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "recruitment_ai_idempotency_keys" (
      "id" SERIAL NOT NULL,
      "idempotency_key" character varying(255) NOT NULL,
      "endpoint" character varying(150) NOT NULL,
      "request_hash" character varying(64) NOT NULL,
      "status" "public"."recruitment_ai_idempotency_keys_status_enum" NOT NULL DEFAULT 'IN_PROGRESS',
      "response_body" jsonb,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_recruitment_ai_idempotency_keys" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_recruitment_ai_idempotency_key" ON "recruitment_ai_idempotency_keys" ("idempotency_key", "endpoint")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recruitment_ai_idempotency_created" ON "recruitment_ai_idempotency_keys" ("created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'recruitment_ai_idempotency_keys',
      'recruitment_handoffs',
      'recruitment_interviews',
      'recruitment_interview_slots',
      'recruitment_messages',
      'recruitment_conversations',
      'recruitment_applications',
      'recruitment_candidates',
      'recruitment_jobs',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
    }

    for (const type of [
      'recruitment_ai_idempotency_keys_status_enum',
      'recruitment_handoffs_requested_by_type_enum',
      'recruitment_handoffs_status_enum',
      'recruitment_handoffs_priority_enum',
      'recruitment_handoffs_reason_enum',
      'recruitment_interviews_created_by_type_enum',
      'recruitment_interviews_status_enum',
      'recruitment_messages_content_type_enum',
      'recruitment_messages_direction_enum',
      'recruitment_messages_sender_type_enum',
      'recruitment_conversations_status_enum',
      'recruitment_conversations_channel_enum',
      'recruitment_applications_ai_match_level_enum',
      'recruitment_applications_source_enum',
      'recruitment_applications_status_enum',
      'recruitment_candidates_source_enum',
      'recruitment_jobs_status_enum',
      'recruitment_jobs_employment_type_enum',
    ]) {
      await queryRunner.query(`DROP TYPE IF EXISTS "public"."${type}"`);
    }
  }
}
