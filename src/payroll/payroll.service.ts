import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Employee } from '../employee/employee.entity';
import { Teacher } from '../teaching/entities/teacher.entity';
import { TeachingSession } from '../teaching/entities/teaching-session.entity';
import { SessionStatus } from '../teaching/teaching.enum';
import { TEACHER_STAFF_ROLE } from '../teaching/teaching-roles';
import { AuthUser } from '../type/auth-user.type';
import { CreatePayrollDto } from './dto/create-payroll.dto';
import { QueryPayrollDto } from './dto/query-payroll.dto';
import { UpdatePayrollDto } from './dto/update-payroll.dto';
import { Payroll } from './entities/payroll.entity';
import { calculatePayrollTotals } from './payroll-calculation';
import { canViewAllPayrolls } from './payroll.roles';
import { PayrollStatus } from './payroll-status.enum';

const PAYROLL_NUMBER_FIELDS = [
  'standardWorkingDays',
  'probationWorkingDays',
  'officialWorkingDays',
  'annualLeaveDays',
  'holidayDays',
  'unpaidLeaveDays',
  'excessPeriods',
  'remainingLeavePreviousYear',
  'remainingLeaveCurrentYear',
  'baseSalary',
  'officialWorkSalary',
  'probationWorkSalary',
  'fuelAllowance',
  'overtimeAllowance',
  'excessPeriodAllowance',
  'otherSupport',
  'bonus',
  'socialInsurance',
  'personalIncomeTax',
  'adjustmentAmount',
  'advancePayment',
] as const;

@Injectable()
export class PayrollService {
  constructor(
    @InjectRepository(Payroll)
    private readonly payrollRepo: Repository<Payroll>,
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(Teacher)
    private readonly teacherRepo: Repository<Teacher>,
    @InjectRepository(TeachingSession)
    private readonly teachingSessionRepo: Repository<TeachingSession>,
  ) {}

  /**
   * Phụ cấp xăng xe của giáo viên công ty không nhập tay — cộng dồn từ
   * `gasAllowance` đã chốt trên từng buổi dạy có chấm công "Có dạy" trong
   * bảng chấm công (`teaching_sessions`) của đúng tháng/năm phiếu lương.
   * Trả `null` nếu nhân viên không phải giáo viên công ty (FE giữ ô nhập tay
   * như cũ cho các vai trò khác).
   */
  async computeFuelAllowanceFromAttendance(
    employeeId: number,
    month: number,
    year: number,
  ): Promise<number | null> {
    const employee = await this.employeeRepo.findOne({
      where: { id: employeeId },
    });
    if (!employee?.roles?.includes(TEACHER_STAFF_ROLE)) return null;

    const teacher = await this.teacherRepo.findOne({
      where: { employeeId },
    });
    if (!teacher) return null;

    const raw = await this.teachingSessionRepo
      .createQueryBuilder('session')
      .select('COALESCE(SUM(session.gasAllowance), 0)', 'sum')
      .where('session.teacherId = :teacherId', { teacherId: teacher.id })
      .andWhere('session.status = :status', { status: SessionStatus.PRESENT })
      .andWhere('EXTRACT(MONTH FROM session.date) = :month', { month })
      .andWhere('EXTRACT(YEAR FROM session.date) = :year', { year })
      .getRawOne<{ sum: string }>();

    return Number(raw?.sum ?? 0);
  }

  async create(dto: CreatePayrollDto, creator: AuthUser) {
    const employee = await this.employeeRepo.findOne({
      where: { id: dto.employeeId },
      relations: { department: true },
    });
    if (!employee) throw new NotFoundException('Nhân viên không tồn tại');

    const duplicate = await this.payrollRepo.exist({
      where: { employeeId: dto.employeeId, year: dto.year, month: dto.month },
    });
    if (duplicate) {
      throw new ConflictException(
        `Nhân viên đã có phiếu lương tháng ${dto.month}/${dto.year}`,
      );
    }

    const values = this.withNumberDefaults(dto);
    const autoFuelAllowance = await this.computeFuelAllowanceFromAttendance(
      employee.id!,
      dto.month,
      dto.year,
    );
    if (autoFuelAllowance !== null) values.fuelAllowance = autoFuelAllowance;

    const payroll = this.payrollRepo.create({
      ...values,
      employeeId: employee.id!,
      employee,
      employeeName: employee.name?.trim() || `Nhân viên #${employee.id}`,
      month: dto.month,
      year: dto.year,
      jobTitle: dto.jobTitle?.trim() || employee.department?.name || null,
      leaveNote: dto.leaveNote?.trim() || null,
      adjustmentNote: dto.adjustmentNote?.trim() || null,
      note: dto.note?.trim() || null,
      createdById: creator.id,
      createdByName: creator.name?.trim() || null,
      // Luôn tạo ở trạng thái nháp — nhân viên chỉ thấy sau khi được gửi.
      status: PayrollStatus.DRAFT,
      ...calculatePayrollTotals(values),
    });

    try {
      const saved = await this.payrollRepo.save(payroll);
      return this.findOne(saved.id, creator);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === '23505'
      ) {
        throw new ConflictException(
          `Nhân viên đã có phiếu lương tháng ${dto.month}/${dto.year}`,
        );
      }
      throw error;
    }
  }

  async findAll(query: QueryPayrollDto, user: AuthUser) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const qb = this.payrollRepo
      .createQueryBuilder('payroll')
      .leftJoinAndSelect('payroll.employee', 'employee')
      .leftJoinAndSelect('employee.department', 'department')
      .orderBy('payroll.year', 'DESC')
      .addOrderBy('payroll.month', 'DESC')
      .addOrderBy('payroll.employeeName', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);

    // Lương là dữ liệu riêng tư: người không có quyền xem tổng chỉ thấy chính mình.
    if (canViewAllPayrolls(user.roles)) {
      if (query.employeeId) {
        qb.andWhere('payroll.employeeId = :employeeId', {
          employeeId: query.employeeId,
        });
      }
      if (query.status) {
        qb.andWhere('payroll.status = :status', { status: query.status });
      }
    } else {
      // Phiếu còn nháp là bản đang soạn — nhân viên chỉ thấy sau khi được gửi.
      qb.andWhere('payroll.employeeId = :employeeId', { employeeId: user.id });
      qb.andWhere('payroll.status = :status', { status: PayrollStatus.SENT });
    }

    if (query.year) qb.andWhere('payroll.year = :year', { year: query.year });
    if (query.month)
      qb.andWhere('payroll.month = :month', { month: query.month });

    const [rows, total] = await qb.getManyAndCount();
    return {
      data: rows.map((row) => this.toResponse(row)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: number, user: AuthUser) {
    const payroll = await this.payrollRepo.findOne({
      where: { id },
      relations: { employee: { department: true } },
    });
    if (!payroll) throw new NotFoundException('Phiếu lương không tồn tại');

    if (!canViewAllPayrolls(user.roles)) {
      const isOwnSentPayroll =
        payroll.employeeId === user.id && payroll.status === PayrollStatus.SENT;
      if (!isOwnSentPayroll) {
        // Ẩn cả sự tồn tại của phiếu lương người khác / phiếu còn nháp.
        throw new NotFoundException('Phiếu lương không tồn tại');
      }
    }
    return this.toResponse(payroll);
  }

  async update(id: number, dto: UpdatePayrollDto, user: AuthUser) {
    const payroll = await this.getEntity(id);
    const values = this.withNumberDefaults({ ...payroll, ...dto });

    // month/year không sửa được nên vẫn tính đúng chu kỳ của phiếu; chấm công
    // có thể được cập nhật sau khi tạo phiếu nên luôn tính lại, không giữ số cũ.
    const autoFuelAllowance = await this.computeFuelAllowanceFromAttendance(
      payroll.employeeId,
      payroll.month,
      payroll.year,
    );
    if (autoFuelAllowance !== null) values.fuelAllowance = autoFuelAllowance;

    Object.assign(payroll, dto, values, calculatePayrollTotals(values));
    if (dto.jobTitle !== undefined)
      payroll.jobTitle = dto.jobTitle.trim() || null;
    if (dto.leaveNote !== undefined)
      payroll.leaveNote = dto.leaveNote.trim() || null;
    if (dto.adjustmentNote !== undefined) {
      payroll.adjustmentNote = dto.adjustmentNote.trim() || null;
    }
    if (dto.note !== undefined) payroll.note = dto.note.trim() || null;

    await this.payrollRepo.save(payroll);
    return this.findOne(id, user);
  }

  async remove(id: number) {
    const payroll = await this.getEntity(id);
    await this.payrollRepo.remove(payroll);
    return { success: true };
  }

  /**
   * Gửi hàng loạt các phiếu đang nháp — từ đây nhân viên mới thấy phiếu của
   * mình. Phiếu đã gửi rồi thì bỏ qua (không lỗi), để nút "Gửi phiếu lương"
   * bấm lại an toàn khi người dùng chọn lẫn cả phiếu đã gửi lẫn phiếu nháp.
   */
  async send(ids: number[], sender: AuthUser) {
    if (!ids.length) {
      throw new BadRequestException('Chưa chọn phiếu lương nào để gửi');
    }

    const payrolls = await this.payrollRepo.find({ where: { id: In(ids) } });
    if (!payrolls.length) {
      throw new NotFoundException('Không tìm thấy phiếu lương nào để gửi');
    }

    const toSend = payrolls.filter((p) => p.status === PayrollStatus.DRAFT);
    if (toSend.length) {
      const now = new Date();
      toSend.forEach((payroll) => {
        payroll.status = PayrollStatus.SENT;
        payroll.sentAt = now;
        payroll.sentById = sender.id;
        payroll.sentByName = sender.name?.trim() || null;
      });
      await this.payrollRepo.save(toSend);
    }

    return {
      sent: toSend.length,
      alreadySent: payrolls.length - toSend.length,
      notFound: ids.length - payrolls.length,
    };
  }

  private async getEntity(id: number) {
    const payroll = await this.payrollRepo.findOne({ where: { id } });
    if (!payroll) throw new NotFoundException('Phiếu lương không tồn tại');
    return payroll;
  }

  private withNumberDefaults<
    T extends Partial<Record<(typeof PAYROLL_NUMBER_FIELDS)[number], number>>,
  >(source: T) {
    const values: Record<string, number> = {};
    for (const field of PAYROLL_NUMBER_FIELDS)
      values[field] = Number(source[field] ?? 0);
    return values as Record<(typeof PAYROLL_NUMBER_FIELDS)[number], number>;
  }

  private toResponse(payroll: Payroll) {
    return {
      ...payroll,
      employee: payroll.employee
        ? {
            id: payroll.employee.id,
            name: payroll.employee.name,
            email: payroll.employee.email,
            phone: payroll.employee.phone,
            department: payroll.employee.department
              ? {
                  id: payroll.employee.department.id,
                  name: payroll.employee.department.name,
                }
              : null,
          }
        : undefined,
    };
  }
}
