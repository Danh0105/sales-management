import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RecruitmentHireAccounts1794100000000 implements MigrationInterface {
  name = 'RecruitmentHireAccounts1794100000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE recruitment_jobs ADD COLUMN position_role varchar(50)`,
    );
    await q.query(
      `ALTER TABLE recruitment_candidates ADD COLUMN employee_id integer UNIQUE REFERENCES employee(id) ON DELETE RESTRICT`,
    );
    await q.query(
      `ALTER TABLE recruitment_applications ADD COLUMN employee_id integer UNIQUE REFERENCES employee(id) ON DELETE RESTRICT`,
    );
    await q.query(
      `ALTER TABLE recruitment_applications ADD CONSTRAINT chk_recruitment_hired_account_status CHECK (employee_id IS NULL OR status='HIRED')`,
    );
    // Chặn writer giữ snapshot cũ làm mất liên kết vừa cấp (AI/HR khác phiên).
    await q.query(`CREATE FUNCTION recruitment_keep_employee_link() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.employee_id IS NOT NULL AND NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
          RAISE EXCEPTION 'RECRUITMENT_EMPLOYEE_LINK_IMMUTABLE' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $$`);
    for (const table of [
      'recruitment_candidates',
      'recruitment_applications',
    ]) {
      await q.query(
        `CREATE TRIGGER trg_recruitment_keep_employee_link BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION recruitment_keep_employee_link()`,
      );
    }
    // Không đoán chức danh hay tự cấp tài khoản cho dữ liệu HIRED cũ.
  }
  async down(q: QueryRunner): Promise<void> {
    const [row] = (await q.query(
      `SELECT EXISTS(SELECT 1 FROM recruitment_candidates WHERE employee_id IS NOT NULL) OR EXISTS(SELECT 1 FROM recruitment_applications WHERE employee_id IS NOT NULL) AS used`,
    )) as { used: boolean }[];
    if (row.used)
      throw new Error(
        'REFUSING_TO_DROP_HIRE_ACCOUNT_LINKS: giữ liên kết tài khoản đã cấp',
      );
    for (const table of [
      'recruitment_candidates',
      'recruitment_applications',
    ]) {
      await q.query(
        `DROP TRIGGER trg_recruitment_keep_employee_link ON ${table}`,
      );
    }
    await q.query(`DROP FUNCTION recruitment_keep_employee_link()`);
    await q.query(
      `ALTER TABLE recruitment_applications DROP CONSTRAINT chk_recruitment_hired_account_status`,
    );
    await q.query(
      `ALTER TABLE recruitment_applications DROP COLUMN employee_id`,
    );
    await q.query(`ALTER TABLE recruitment_candidates DROP COLUMN employee_id`);
    await q.query(`ALTER TABLE recruitment_jobs DROP COLUMN position_role`);
  }
}
