import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Raw, type EntityManager } from 'typeorm';
import { Department } from '../../department/department.entity';
import { Employee } from '../../employee/employee.entity';
import { employeePosition } from '../../employee/employee-positions';
import { Teacher } from '../../teaching/entities/teacher.entity';
import {
  TEACHER_ROLES,
  TEACHER_STAFF_DEPARTMENT,
  TEACHER_STAFF_ROLE,
} from '../../teaching/teaching-roles';
import type { UpdateApplicationStatusDto } from '../dto/application.dto';
import { RecruitmentCandidate } from '../entities/recruitment-candidate.entity';
import { RecruitmentJob } from '../entities/recruitment-job.entity';
import { RecruitmentActorType } from '../recruitment.enums';
import {
  RECRUITMENT_MANAGE_ROLES,
  type RecruitmentActor,
} from '../recruitment.roles';

/** Chỉ dùng trong transaction HR chuyển OFFER → HIRED; không có API/tool AI. */
export async function createHireAccount(
  em: EntityManager,
  candidateId: number,
  jobId: number,
  dto: UpdateApplicationStatusDto,
  actor: RecruitmentActor,
): Promise<number> {
  if (
    actor.type !== RecruitmentActorType.HR ||
    !actor.employeeId ||
    !actor.roles.some((role) => RECRUITMENT_MANAGE_ROLES.includes(role))
  ) {
    throw new ForbiddenException(
      'Chỉ Nhân sự được cấp tài khoản khi tuyển thành công',
    );
  }
  // Khoá ứng viên: hai hồ sơ khác nhau của cùng một người không thể cấp hai tài khoản.
  const candidateRepo = em.getRepository(RecruitmentCandidate);
  const candidate = await candidateRepo.findOne({
    where: { id: candidateId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!candidate) throw new ConflictException('Không tìm thấy ứng viên');
  if (candidate.employeeId) {
    throw new ConflictException({
      code: 'CANDIDATE_ALREADY_EMPLOYEE',
      message:
        'Ứng viên đã có tài khoản từ lần tuyển trước. HR kiểm tra tại Nhân viên, không cấp thêm quyền tự động.',
    });
  }
  if (candidate.deletionRequestedAt) {
    throw new ConflictException({
      code: 'CANDIDATE_DELETION_PENDING',
      message:
        'Ứng viên đang yêu cầu xoá dữ liệu; cần HR xử lý trước khi tuyển.',
    });
  }
  // Read lock giữ nguyên quyền/đơn vị được HR xác nhận cho tới commit.
  const job = await em
    .getRepository(RecruitmentJob)
    .findOne({ where: { id: jobId }, lock: { mode: 'pessimistic_read' } });
  const position = employeePosition(job?.positionRole);
  if (!job || !position) {
    throw new BadRequestException({
      code: 'POSITION_REQUIRED',
      message:
        'Vị trí chưa gắn chức danh hệ thống. Hãy sửa vị trí trước khi xác nhận Đã tuyển.',
    });
  }
  if (dto.confirmAccountRole !== true) {
    throw new BadRequestException({
      code: 'ACCOUNT_ROLE_CONFIRMATION_REQUIRED',
      message: `Cần xác nhận cấp quyền ${position.label} cho tài khoản mới`,
    });
  }
  if (dto.accountPositionRole !== position.value) {
    throw new ConflictException({
      code: 'ACCOUNT_POSITION_CHANGED',
      message:
        'Chức danh đã thay đổi; mở lại hồ sơ và xác nhận quyền tài khoản mới.',
    });
  }
  if (!candidate.fullName?.trim() || !candidate.phone) {
    throw new BadRequestException({
      code: 'ACCOUNT_PROFILE_INCOMPLETE',
      message:
        'Cần họ tên và số điện thoại ứng viên để tạo tài khoản đăng nhập',
    });
  }
  if (
    !dto.password ||
    dto.password.trim().length < 8 ||
    Buffer.byteLength(dto.password, 'utf8') > 72
  ) {
    throw new BadRequestException({
      code: 'ACCOUNT_PASSWORD_REQUIRED',
      message: 'HR cần đặt mật khẩu ban đầu (ít nhất 8 ký tự, tối đa 72 byte)',
    });
  }
  const employeeRepo = em.getRepository(Employee);
  const contacts = [
    { phone: candidate.phone },
    ...(candidate.email
      ? [
          {
            email: Raw((alias) => `LOWER(${alias}) = :hireEmail`, {
              hireEmail: candidate.email.toLowerCase(),
            }),
          },
        ]
      : []),
  ];
  if (await employeeRepo.findOne({ where: contacts })) {
    throw new ConflictException({
      code: 'EMPLOYEE_CONTACT_EXISTS',
      message:
        'Số điện thoại/email đã có tài khoản. HR cần đối soát, hệ thống không tự ghép hoặc đổi quyền tài khoản có sẵn.',
    });
  }
  const teacherRole = TEACHER_ROLES.includes(position.value);
  const teacherRepo = em.getRepository(Teacher);
  if (teacherRole && (await teacherRepo.findOne({ where: contacts }))) {
    throw new ConflictException({
      code: 'TEACHER_CONTACT_EXISTS',
      message:
        'Đã có hồ sơ giáo viên với liên hệ này; HR cần đối soát trước khi tuyển.',
    });
  }
  const departmentId = await hireDepartmentId(
    em,
    position.value,
    job.departmentId,
  );
  const employee = await employeeRepo.save(
    employeeRepo.create({
      name: candidate.fullName.trim(),
      phone: candidate.phone,
      email: candidate.email ?? undefined,
      password: await bcrypt.hash(dto.password, 10),
      roles: [position.value],
      isActive: true,
      ...(departmentId ? { department: { id: departmentId } } : {}),
    }),
  );
  if (!employee.id) throw new Error('HIRE_ACCOUNT_ID_MISSING');
  // HIRED là duyệt của HR; tạo cả hồ sơ giáo viên, không sinh tài khoản giáo viên mồ côi.
  if (teacherRole) {
    await teacherRepo.save(
      teacherRepo.create({
        name: candidate.fullName.trim(),
        phone: candidate.phone,
        email: candidate.email,
        employeeId: employee.id,
        isActive: true,
      }),
    );
  }
  // Không copy Zalo ID OA tuyển dụng sang OA công ty/Mini App: khác miền định danh.
  await candidateRepo.update(candidate.id, { employeeId: employee.id });
  return employee.id;
}

/**
 * Giáo viên công ty luôn vào phòng Chuyên môn, bất kể phòng ghi trên vị trí
 * tuyển; chức danh khác theo phòng của vị trí. Chưa có phòng Chuyên môn thì
 * theo vị trí như trước.
 */
async function hireDepartmentId(
  em: EntityManager,
  role: string,
  jobDepartmentId: number | null,
): Promise<number | null> {
  if (role === TEACHER_STAFF_ROLE) {
    const staff = await em.getRepository(Department).findOne({
      where: { name: TEACHER_STAFF_DEPARTMENT },
      select: { id: true },
    });
    if (staff) return staff.id;
  }
  return jobDepartmentId;
}
