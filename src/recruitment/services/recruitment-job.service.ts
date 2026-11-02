import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Department } from '../../department/department.entity';
import type { Paginated } from '../dto/common.dto';
import type {
  CreateJobDto,
  QueryJobDto,
  ScreeningCriteriaDto,
  UpdateJobDto,
} from '../dto/job.dto';
import { RecruitmentJob } from '../entities/recruitment-job.entity';
import { RecruitmentAuditService } from '../recruitment-audit.service';
import { RecruitmentJobStatus } from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';
import {
  isUniqueViolation,
  likePattern,
  toAiJobView,
} from '../recruitment.views';
import type { ScreeningCriteria } from '../screening/screening.types';

const { DRAFT, ACTIVE, PAUSED, CLOSED } = RecruitmentJobStatus;

/** Trạng thái được phép đi tới cho từng thao tác publish/pause/close. */
const JOB_TRANSITIONS: Record<
  'publish' | 'pause' | 'close',
  {
    from: RecruitmentJobStatus[];
    to: RecruitmentJobStatus;
  }
> = {
  publish: { from: [DRAFT, PAUSED], to: ACTIVE },
  pause: { from: [ACTIVE], to: PAUSED },
  close: { from: [DRAFT, ACTIVE, PAUSED], to: CLOSED },
};

/** Chỉ giữ khoá đã khai trong schema và bỏ trùng kỹ năng/địa điểm. */
export function toScreeningCriteria(
  dto: ScreeningCriteriaDto | undefined,
): ScreeningCriteria {
  if (!dto) return {};
  const unique = (list?: string[]) =>
    list
      ? [...new Map(list.map((s) => [s.toLowerCase(), s])).values()]
      : undefined;

  const criteria: ScreeningCriteria = {
    minimumExperienceMonths: dto.minimumExperienceMonths,
    requiredSkills: unique(dto.requiredSkills),
    preferredSkills: unique(dto.preferredSkills),
    locations: unique(dto.locations),
    availableImmediatelyPreferred: dto.availableImmediatelyPreferred,
    maxStartDelayDays: dto.maxStartDelayDays,
  };
  return Object.fromEntries(
    Object.entries(criteria).filter(([, v]) => v !== undefined && v !== null),
  ) as ScreeningCriteria;
}

@Injectable()
export class RecruitmentJobService {
  constructor(
    @InjectRepository(RecruitmentJob)
    private readonly jobRepo: Repository<RecruitmentJob>,
    @InjectRepository(Department)
    private readonly departmentRepo: Repository<Department>,
    private readonly audit: RecruitmentAuditService,
  ) {}

  async create(dto: CreateJobDto, actor: RecruitmentActor) {
    this.assertSalaryRange(dto.salaryMin ?? null, dto.salaryMax ?? null);
    await this.assertDepartment(dto.departmentId);
    await this.assertCodeFree(dto.code);

    const job = this.jobRepo.create({
      code: dto.code,
      title: dto.title,
      description: dto.description ?? null,
      departmentId: dto.departmentId ?? null,
      location: dto.location ?? null,
      employmentType: dto.employmentType,
      numberOfPositions: dto.numberOfPositions ?? 1,
      salaryMin: dto.salaryMin ?? null,
      salaryMax: dto.salaryMax ?? null,
      currency: dto.currency ?? 'VND',
      requirements: dto.requirements ?? null,
      responsibilities: dto.responsibilities ?? null,
      screeningCriteria: toScreeningCriteria(dto.screeningCriteria),
      status: DRAFT,
      createdBy: actor.employeeId,
    });

    const saved = await this.saveHandlingCode(job);
    await this.audit.record({
      actor,
      action: 'JOB_CREATE',
      entity: 'jobs',
      entityId: saved.id,
      after: saved,
    });
    return this.findOne(saved.id);
  }

  async findAll(query: QueryJobDto): Promise<Paginated<RecruitmentJob>> {
    const { page, limit } = query;
    const qb = this.jobRepo
      .createQueryBuilder('job')
      .leftJoinAndSelect('job.department', 'department');

    if (query.status)
      qb.andWhere('job.status = :status', { status: query.status });
    if (query.departmentId)
      qb.andWhere('job.departmentId = :departmentId', {
        departmentId: query.departmentId,
      });
    if (query.keyword) {
      qb.andWhere('(job.title ILIKE :kw OR job.code ILIKE :kw)', {
        kw: likePattern(query.keyword),
      });
    }

    const [data, total] = await qb
      .orderBy('job.createdAt', 'DESC')
      .addOrderBy('job.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { data, total, page, limit };
  }

  async findOne(id: number): Promise<RecruitmentJob> {
    const job = await this.jobRepo.findOne({
      where: { id },
      relations: { department: true },
    });
    if (!job) {
      throw new NotFoundException({
        code: 'JOB_NOT_FOUND',
        message: `Không tìm thấy vị trí tuyển dụng #${id}`,
      });
    }
    return job;
  }

  async update(id: number, dto: UpdateJobDto, actor: RecruitmentActor) {
    const job = await this.findOne(id);
    if (job.status === CLOSED) {
      throw new ConflictException({
        code: 'JOB_CLOSED',
        message: 'Vị trí đã đóng, không sửa được nữa',
      });
    }
    const before = { ...job };

    const salaryMin =
      dto.salaryMin !== undefined ? dto.salaryMin : job.salaryMin;
    const salaryMax =
      dto.salaryMax !== undefined ? dto.salaryMax : job.salaryMax;
    this.assertSalaryRange(salaryMin, salaryMax);
    if (dto.departmentId !== undefined)
      await this.assertDepartment(dto.departmentId);
    if (dto.code !== undefined && dto.code !== job.code)
      await this.assertCodeFree(dto.code);

    // `null` xoá được field tuỳ chọn; field bắt buộc thì bỏ qua null.
    const assign = <K extends keyof RecruitmentJob>(
      key: K,
      value: RecruitmentJob[K] | undefined,
    ) => {
      if (value !== undefined) job[key] = value;
    };
    const assignRequired = <K extends keyof RecruitmentJob>(
      key: K,
      value: RecruitmentJob[K] | null | undefined,
    ) => {
      if (value !== undefined && value !== null) job[key] = value;
    };
    assignRequired('code', dto.code);
    assignRequired('title', dto.title);
    assign('description', dto.description);
    assign('departmentId', dto.departmentId);
    assign('location', dto.location);
    assignRequired('employmentType', dto.employmentType);
    assignRequired('numberOfPositions', dto.numberOfPositions);
    assign('salaryMin', dto.salaryMin);
    assign('salaryMax', dto.salaryMax);
    assignRequired('currency', dto.currency);
    assign('requirements', dto.requirements);
    assign('responsibilities', dto.responsibilities);
    if (dto.screeningCriteria !== undefined) {
      job.screeningCriteria = toScreeningCriteria(dto.screeningCriteria);
    }
    // Quan hệ đã load sẽ ghi đè departmentId khi save — bỏ đi để FK đi theo id.
    delete job.department;

    const saved = await this.saveHandlingCode(job);
    await this.audit.record({
      actor,
      action: 'JOB_UPDATE',
      entity: 'jobs',
      entityId: id,
      before,
      after: saved,
    });
    return this.findOne(id);
  }

  publish(id: number, actor: RecruitmentActor) {
    return this.changeStatus(id, 'publish', actor);
  }

  pause(id: number, actor: RecruitmentActor) {
    return this.changeStatus(id, 'pause', actor);
  }

  close(id: number, actor: RecruitmentActor) {
    return this.changeStatus(id, 'close', actor);
  }

  /** Vị trí AI được giới thiệu cho ứng viên. */
  async findActiveForAi() {
    const jobs = await this.jobRepo.find({
      where: { status: ACTIVE },
      relations: { department: true },
      order: { publishedAt: 'DESC', id: 'DESC' },
      take: 100,
    });
    return { data: jobs.map(toAiJobView) };
  }

  /** Nháp chưa công bố thì AI không được thấy. */
  async findOneForAi(id: number) {
    const job = await this.findOne(id);
    if (job.status === DRAFT) {
      throw new NotFoundException({
        code: 'JOB_NOT_FOUND',
        message: `Không tìm thấy vị trí tuyển dụng #${id}`,
      });
    }
    return toAiJobView(job);
  }

  private async changeStatus(
    id: number,
    op: keyof typeof JOB_TRANSITIONS,
    actor: RecruitmentActor,
  ) {
    const job = await this.findOne(id);
    const rule = JOB_TRANSITIONS[op];
    if (!rule.from.includes(job.status)) {
      throw new ConflictException({
        code: 'INVALID_JOB_STATUS_TRANSITION',
        message: `Không thể chuyển vị trí từ ${job.status} sang ${rule.to}`,
      });
    }
    const before = { ...job };
    const now = new Date();

    job.status = rule.to;
    if (rule.to === ACTIVE && !job.publishedAt) job.publishedAt = now;
    if (rule.to === CLOSED) job.closedAt = now;
    delete job.department;

    const saved = await this.jobRepo.save(job);
    await this.audit.record({
      actor,
      action:
        op === 'publish'
          ? 'JOB_PUBLISH'
          : op === 'pause'
            ? 'JOB_PAUSE'
            : 'JOB_CLOSE',
      entity: 'jobs',
      entityId: id,
      before,
      after: saved,
    });
    return this.findOne(id);
  }

  private assertSalaryRange(min: number | null, max: number | null) {
    if (min !== null && max !== null && min > max) {
      throw new BadRequestException({
        code: 'INVALID_SALARY_RANGE',
        message: 'salaryMin không được lớn hơn salaryMax',
      });
    }
  }

  private async assertDepartment(departmentId?: number | null) {
    if (!departmentId) return;
    const exists = await this.departmentRepo.exists({
      where: { id: departmentId },
    });
    if (!exists) {
      throw new BadRequestException({
        code: 'DEPARTMENT_NOT_FOUND',
        message: `Không tìm thấy phòng ban #${departmentId}`,
      });
    }
  }

  private async assertCodeFree(code: string) {
    const exists = await this.jobRepo.exists({ where: { code } });
    if (exists) throw this.codeTaken(code);
  }

  private codeTaken(code: string) {
    return new ConflictException({
      code: 'JOB_CODE_EXISTS',
      message: `Mã vị trí ${code} đã tồn tại`,
    });
  }

  private async saveHandlingCode(job: RecruitmentJob) {
    try {
      return await this.jobRepo.save(job);
    } catch (error) {
      if (isUniqueViolation(error)) throw this.codeTaken(job.code);
      throw error;
    }
  }
}
