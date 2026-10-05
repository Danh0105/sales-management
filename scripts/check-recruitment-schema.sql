-- Kiểm schema Tuyển dụng trên DB — CHỈ ĐỌC (session đặt read-only).
-- Chạy:  psql -h localhost -U postgres -d sales_db -f scripts/check-recruitment-schema.sql
-- Mọi khối "thiếu/lệch" phải trả 0 dòng; khối đếm phải đúng số kỳ vọng.
-- Tên bảng/index/constraint sinh từ migration 1791800000000-create-recruitment.ts.

SET default_transaction_read_only = on;
\pset footer off

\echo '1. Số bảng recruitment (kỳ vọng 9)'
SELECT count(*) AS tables
FROM pg_tables
WHERE schemaname = 'public' AND tablename = ANY(ARRAY[
    'recruitment_jobs',
    'recruitment_candidates',
    'recruitment_applications',
    'recruitment_conversations',
    'recruitment_messages',
    'recruitment_interview_slots',
    'recruitment_interviews',
    'recruitment_handoffs',
    'recruitment_ai_idempotency_keys'
  ]);

\echo '2. Index thiếu (kỳ vọng 0 dòng / 24 index)'
SELECT expected AS missing_index
FROM unnest(ARRAY[
    'UQ_recruitment_jobs_code',
    'IDX_recruitment_jobs_status',
    'UQ_recruitment_candidates_zalo_user_id',
    'IDX_recruitment_candidates_phone',
    'IDX_recruitment_candidates_email',
    'IDX_recruitment_applications_candidate',
    'IDX_recruitment_applications_job',
    'IDX_recruitment_applications_status',
    'UQ_recruitment_applications_active',
    'IDX_recruitment_conversations_candidate',
    'UQ_recruitment_conversations_external',
    'IDX_recruitment_messages_conversation_created',
    'UQ_recruitment_messages_external',
    'IDX_recruitment_interview_slots_start',
    'IDX_recruitment_interview_slots_job',
    'IDX_recruitment_interviews_application',
    'IDX_recruitment_interviews_scheduled_start',
    'UQ_recruitment_interviews_active',
    'IDX_recruitment_handoffs_status_created',
    'IDX_recruitment_handoffs_candidate',
    'IDX_recruitment_handoffs_application',
    'UQ_recruitment_handoffs_open_reason',
    'UQ_recruitment_ai_idempotency_key',
    'IDX_recruitment_ai_idempotency_created'
  ]) AS expected
WHERE NOT EXISTS (
  SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = expected
);

\echo '3. Điều kiện của unique partial index (đối chiếu bằng mắt)'
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND indexname LIKE 'UQ\_recruitment%'
ORDER BY indexname;

\echo '4. PK / FK / CHECK thiếu (kỳ vọng 0 dòng / 38 constraint)'
SELECT expected AS missing_constraint
FROM unnest(ARRAY[
    'PK_recruitment_jobs',
    'CHK_recruitment_jobs_positions',
    'CHK_recruitment_jobs_salary',
    'FK_recruitment_jobs_department',
    'FK_recruitment_jobs_created_by',
    'PK_recruitment_candidates',
    'CHK_recruitment_candidates_experience',
    'CHK_recruitment_candidates_salary',
    'PK_recruitment_applications',
    'CHK_recruitment_applications_score',
    'FK_recruitment_applications_candidate',
    'FK_recruitment_applications_job',
    'FK_recruitment_applications_reviewed_by',
    'PK_recruitment_conversations',
    'FK_recruitment_conversations_candidate',
    'FK_recruitment_conversations_application',
    'PK_recruitment_messages',
    'FK_recruitment_messages_conversation',
    'PK_recruitment_interview_slots',
    'CHK_recruitment_interview_slots_time',
    'CHK_recruitment_interview_slots_capacity',
    'FK_recruitment_interview_slots_job',
    'FK_recruitment_interview_slots_interviewer',
    'FK_recruitment_interview_slots_created_by',
    'PK_recruitment_interviews',
    'CHK_recruitment_interviews_time',
    'FK_recruitment_interviews_application',
    'FK_recruitment_interviews_candidate',
    'FK_recruitment_interviews_job',
    'FK_recruitment_interviews_slot',
    'FK_recruitment_interviews_interviewer',
    'FK_recruitment_interviews_created_by',
    'PK_recruitment_handoffs',
    'FK_recruitment_handoffs_candidate',
    'FK_recruitment_handoffs_application',
    'FK_recruitment_handoffs_requested_by',
    'FK_recruitment_handoffs_resolved_by',
    'PK_recruitment_ai_idempotency_keys'
  ]) AS expected
WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = expected);

\echo '5. Hành vi FK (ON DELETE)'
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE contype = 'f' AND conname LIKE 'FK\_recruitment%'
ORDER BY conname;

\echo '6. Enum lệch giá trị (kỳ vọng 0 dòng / 18 enum)'
WITH expected(typname, labels) AS (
  VALUES
    ('recruitment_jobs_employment_type_enum', 'FULL_TIME,PART_TIME,CONTRACT,INTERNSHIP,COLLABORATOR'),
    ('recruitment_jobs_status_enum', 'DRAFT,ACTIVE,PAUSED,CLOSED'),
    ('recruitment_candidates_source_enum', 'ZALO,WEBSITE,FACEBOOK,REFERRAL,MANUAL,OTHER'),
    ('recruitment_applications_status_enum', 'NEW,COLLECTING_INFO,SCREENING,QUALIFIED,NEEDS_HR_REVIEW,INTERVIEW,OFFER,HIRED,REJECTED,WITHDRAWN'),
    ('recruitment_applications_source_enum', 'ZALO,WEBSITE,FACEBOOK,REFERRAL,MANUAL,OTHER'),
    ('recruitment_applications_ai_match_level_enum', 'HIGH_MATCH,MEDIUM_MATCH,LOW_MATCH,INSUFFICIENT_DATA'),
    ('recruitment_conversations_channel_enum', 'ZALO,WEB,FACEBOOK,OTHER'),
    ('recruitment_conversations_status_enum', 'ACTIVE,CLOSED'),
    ('recruitment_messages_sender_type_enum', 'CANDIDATE,AI,HR,SYSTEM'),
    ('recruitment_messages_direction_enum', 'INBOUND,OUTBOUND'),
    ('recruitment_messages_content_type_enum', 'TEXT,IMAGE,FILE,LINK,OTHER'),
    ('recruitment_interviews_status_enum', 'PROPOSED,CONFIRMED,COMPLETED,CANCELLED,NO_SHOW'),
    ('recruitment_interviews_created_by_type_enum', 'AI,HR,SYSTEM'),
    ('recruitment_handoffs_reason_enum', 'CANDIDATE_REQUESTED_HUMAN,SALARY_OUT_OF_RANGE,AI_UNCERTAIN,COMPLAINT,DATA_DELETION_REQUEST,SPECIAL_CASE,FINAL_DECISION_REQUIRED,OTHER'),
    ('recruitment_handoffs_priority_enum', 'LOW,NORMAL,HIGH,URGENT'),
    ('recruitment_handoffs_status_enum', 'OPEN,RESOLVED,RETURNED_TO_AI'),
    ('recruitment_handoffs_requested_by_type_enum', 'AI,HR,SYSTEM'),
    ('recruitment_ai_idempotency_keys_status_enum', 'IN_PROGRESS,COMPLETED')
), actual AS (
  SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
  FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
  GROUP BY t.typname
)
SELECT x.typname, x.labels AS expected, a.labels AS actual
FROM expected x LEFT JOIN actual a USING (typname)
WHERE a.labels IS DISTINCT FROM x.labels;

\echo '7. Số dòng (trước deploy kỳ vọng 0 ở mọi bảng)'
SELECT 'recruitment_jobs' AS table_name, count(*) AS row_count FROM recruitment_jobs
UNION ALL SELECT 'recruitment_candidates' AS table_name, count(*) AS row_count FROM recruitment_candidates
UNION ALL SELECT 'recruitment_applications' AS table_name, count(*) AS row_count FROM recruitment_applications
UNION ALL SELECT 'recruitment_conversations' AS table_name, count(*) AS row_count FROM recruitment_conversations
UNION ALL SELECT 'recruitment_messages' AS table_name, count(*) AS row_count FROM recruitment_messages
UNION ALL SELECT 'recruitment_interview_slots' AS table_name, count(*) AS row_count FROM recruitment_interview_slots
UNION ALL SELECT 'recruitment_interviews' AS table_name, count(*) AS row_count FROM recruitment_interviews
UNION ALL SELECT 'recruitment_handoffs' AS table_name, count(*) AS row_count FROM recruitment_handoffs
UNION ALL SELECT 'recruitment_ai_idempotency_keys' AS table_name, count(*) AS row_count FROM recruitment_ai_idempotency_keys;

\echo '8. Nhật ký thao tác recruitment (trước deploy kỳ vọng 0)'
SELECT count(*) AS recruitment_activity_logs
FROM activity_log
WHERE resource LIKE 'recruitment%' OR path LIKE '/recruitment%';

\echo '9. Cột bank của employee (ngoài scope Recruitment — 0 dòng nghĩa là cột không tồn tại)'
SELECT
  column_name,
  (xpath('/row/c/text()', query_to_xml(
    format('SELECT count(*) AS c FROM employee WHERE %I IS NOT NULL', column_name),
    false, true, '')))[1]::text::int AS non_null_rows
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'employee'
  AND column_name IN ('bank_account_number', 'bank_name')
ORDER BY column_name;
