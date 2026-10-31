import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThanOrEqual, Repository } from 'typeorm';

import { Department } from '../../department/department.entity';
import { employeePosition } from '../../employee/employee-positions';
import { Employee } from '../../employee/employee.entity';
import { Province } from '../../province/province.entity';
import { Ward } from '../../ward/ward.entity';
import type { Paginated } from '../dto/common.dto';
import type {
  CreateJobDto,
  QueryJobDto,
  RecruitmentWorkLocationDto,
  ScreeningCriteriaDto,
  UpdateJobDto,
} from '../dto/job.dto';
import {
  RecruitmentJob,
  type RecruitmentWorkLocation,
} from '../entities/recruitment-job.entity';
import { RecruitmentAuditService } from '../recruitment-audit.service';
import { RecruitmentJobStatus } from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';
import {
  isUniqueViolation,
  likePattern,
  toAiJobView,
} from '../recruitment.views';
import type { ScreeningCriteria } from '../screening/screening.types';
import {
  hasMeaningfulRecruitmentHtml,
  sanitizeRecruitmentHtml,
} from '../utils/job-html';

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
    @InjectRepository(Province)
    private readonly provinceRepo: Repository<Province>,
    @InjectRepository(Ward)
    private readonly wardRepo: Repository<Ward>,
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
    private readonly audit: RecruitmentAuditService,
  ) {}

  async create(dto: CreateJobDto, actor: RecruitmentActor) {
    const position = this.assertPosition(dto.positionRole);
    const salaryNegotiable = dto.salaryNegotiable ?? false;
    const salaryMin = salaryNegotiable ? null : (dto.salaryMin ?? null);
    const salaryMax = salaryNegotiable ? null : (dto.salaryMax ?? null);
    this.assertSalaryRange(salaryMin, salaryMax);
    await this.assertDepartment(dto.departmentId);
    await this.assertIndustries(dto.industryIds);
    await this.assertCodeFree(dto.code);
    this.assertDeadlineNotPast(dto.applicationDeadline);
    this.assertPhones(dto.contactPhone, dto.additionalPhones);
    const workLocations = await this.canonicalizeWorkLocations(
      dto.workLocations,
    );
    const creator = actor.employeeId
      ? await this.employeeRepo.findOne({ where: { id: actor.employeeId } })
      : null;

    const job = this.jobRepo.create({
      code: dto.code,
      title: dto.title?.trim() || position.label,
      positionRole: position.value,
      description: sanitizeRecruitmentHtml(dto.description),
      departmentId: dto.departmentId ?? null,
      industryIds:
        dto.industryIds ?? (dto.departmentId ? [dto.departmentId] : []),
      seniority: dto.seniority ?? null,
      experienceLevel: dto.experienceLevel ?? null,
      applicationDeadline: dto.applicationDeadline ?? null,
      location: dto.location ?? this.locationSummary(workLocations[0]) ?? null,
      employmentType: dto.employmentType,
      numberOfPositions: dto.numberOfPositions ?? 1,
      salaryMin,
      salaryMax,
      salaryNegotiable,
      salaryStructure: dto.salaryStructure ?? null,
      currency: dto.currency ?? 'VND',
      requirements: sanitizeRecruitmentHtml(dto.requirements),
      responsibilities: sanitizeRecruitmentHtml(dto.responsibilities),
      benefits: sanitizeRecruitmentHtml(dto.benefits),
      educationLevel: dto.educationLevel ?? null,
      probationPeriod: dto.probationPeriod ?? null,
      workLocations,
      allowApplicationsWithoutCv: dto.allowApplicationsWithoutCv ?? true,
      contactName: dto.contactName ?? creator?.name ?? null,
      contactEmail: dto.contactEmail ?? creator?.email ?? null,
      contactPhone: dto.contactPhone ?? creator?.phone ?? null,
      additionalPhones: dto.additionalPhones ?? [],
      screeningCriteria: toScreeningCriteria(dto.screeningCriteria),
      status: DRAFT,
      createdBy: actor.employeeId,
      formVersion: 2,
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
    if (dto.positionRole !== undefined) {
      job.positionRole = this.assertPosition(dto.positionRole).value;
    }

    const salaryMin =
      dto.salaryNegotiable === true
        ? null
        : dto.salaryMin !== undefined
          ? dto.salaryMin
          : job.salaryMin;
    const salaryMax =
      dto.salaryNegotiable === true
        ? null
        : dto.salaryMax !== undefined
          ? dto.salaryMax
          : job.salaryMax;
    this.assertSalaryRange(salaryMin, salaryMax);
    if (dto.departmentId !== undefined)
      await this.assertDepartment(dto.departmentId);
    if (dto.industryIds !== undefined)
      await this.assertIndustries(dto.industryIds);
    if (dto.code !== undefined && dto.code !== job.code)
      await this.assertCodeFree(dto.code);
    if (
      dto.applicationDeadline !== undefined &&
      dto.applicationDeadline !== job.applicationDeadline
    )
      this.assertDeadlineNotPast(dto.applicationDeadline);
    this.assertPhones(
      dto.contactPhone ?? job.contactPhone,
      dto.additionalPhones ?? job.additionalPhones,
    );
    const workLocations =
      dto.workLocations !== undefined
        ? await this.canonicalizeWorkLocations(dto.workLocations)
        : undefined;

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
    if (dto.description !== undefined)
      assign('description', sanitizeRecruitmentHtml(dto.description));
    assign('departmentId', dto.departmentId);
    assign('industryIds', dto.industryIds);
    assign('seniority', dto.seniority);
    assign('experienceLevel', dto.experienceLevel);
    assign('applicationDeadline', dto.applicationDeadline);
    assign('location', dto.location);
    assignRequired('employmentType', dto.employmentType);
    assignRequired('numberOfPositions', dto.numberOfPositions);
    assign('salaryMin', salaryMin);
    assign('salaryMax', salaryMax);
    assignRequired('salaryNegotiable', dto.salaryNegotiable);
    assign('salaryStructure', dto.salaryStructure);
    assignRequired('currency', dto.currency);
    if (dto.requirements !== undefined)
      assign('requirements', sanitizeRecruitmentHtml(dto.requirements));
    if (dto.responsibilities !== undefined)
      assign('responsibilities', sanitizeRecruitmentHtml(dto.responsibilities));
    if (dto.benefits !== undefined)
      assign('benefits', sanitizeRecruitmentHtml(dto.benefits));
    assign('educationLevel', dto.educationLevel);
    assign('probationPeriod', dto.probationPeriod);
    if (workLocations !== undefined) {
      assign('workLocations', workLocations);
      if (dto.location === undefined)
        assign('location', this.locationSummary(workLocations[0]));
    }
    assignRequired(
      'allowApplicationsWithoutCv',
      dto.allowApplicationsWithoutCv,
    );
    assign('contactName', dto.contactName);
    assign('contactEmail', dto.contactEmail);
    assign('contactPhone', dto.contactPhone);
    assign('additionalPhones', dto.additionalPhones);
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

  private assertPosition(role?: string) {
    const position = employeePosition(role);
    if (!position) {
      throw new BadRequestException({
        code: 'POSITION_REQUIRED',
        message: 'Vui lòng chọn chức danh có sẵn trong hệ thống',
      });
    }
    return position;
  }

  pause(id: number, actor: RecruitmentActor) {
    return this.changeStatus(id, 'pause', actor);
  }

  close(id: number, actor: RecruitmentActor) {
    return this.changeStatus(id, 'close', actor);
  }

  /** Vị trí AI được giới thiệu cho ứng viên. */
  async findActiveForAi() {
    const today = this.today();
    const jobs = await this.jobRepo.find({
      where: [
        { status: ACTIVE, applicationDeadline: IsNull() },
        { status: ACTIVE, applicationDeadline: MoreThanOrEqual(today) },
      ],
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
    if (op === 'publish' && (job.formVersion ?? 1) >= 2) {
      this.assertPublishableJob(job);
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

  private async assertIndustries(industryIds?: number[] | null) {
    if (!industryIds?.length) return;
    const count = await this.departmentRepo.countBy({ id: In(industryIds) });
    if (count !== industryIds.length) {
      throw new BadRequestException({
        code: 'INDUSTRY_NOT_FOUND',
        message: 'Có ngành nghề/phòng ban không còn tồn tại',
      });
    }
  }

  private async canonicalizeWorkLocations(
    locations?: RecruitmentWorkLocationDto[] | null,
  ): Promise<RecruitmentWorkLocation[]> {
    if (!locations?.length) return [];
    const provinceIds = [...new Set(locations.map((item) => item.provinceId))];
    const wardIds = [...new Set(locations.map((item) => item.wardId))];
    const [provinces, wards] = await Promise.all([
      this.provinceRepo.findBy({ id: In(provinceIds) }),
      this.wardRepo.findBy({ id: In(wardIds) }),
    ]);
    const provinceMap = new Map(provinces.map((item) => [item.id, item]));
    const wardMap = new Map(wards.map((item) => [item.id, item]));

    return locations.map((item) => {
      const province = provinceMap.get(item.provinceId);
      const ward = wardMap.get(item.wardId);
      if (!province || !ward || ward.province_id !== province.id) {
        throw new BadRequestException({
          code: 'INVALID_WORK_LOCATION',
          message: 'Tỉnh/thành hoặc phường/xã của địa điểm không hợp lệ',
        });
      }
      return {
        provinceId: province.id,
        provinceName: province.name,
        wardId: ward.id,
        wardName: ward.name,
        address: item.address.trim(),
      };
    });
  }

  private locationSummary(location?: RecruitmentWorkLocation): string | null {
    if (!location) return null;
    return [location.address, location.wardName, location.provinceName]
      .filter(Boolean)
      .join(', ');
  }

  private assertPhones(
    contactPhone?: string | null,
    additionalPhones?: string[] | null,
  ) {
    const all = [contactPhone, ...(additionalPhones ?? [])].filter(
      (value): value is string => !!value,
    );
    if (new Set(all).size !== all.length) {
      throw new BadRequestException({
        code: 'DUPLICATE_CONTACT_PHONE',
        message: 'Các số điện thoại liên hệ không được trùng nhau',
      });
    }
  }

  private assertDeadlineNotPast(deadline?: string | null) {
    if (deadline && deadline < this.today()) {
      throw new BadRequestException({
        code: 'APPLICATION_DEADLINE_PASSED',
        message: 'Hạn nộp hồ sơ không được là ngày đã qua',
      });
    }
  }

  private assertPublishableJob(job: RecruitmentJob) {
    const missing: string[] = [];
    if (!job.title?.trim()) missing.push('title');
    if (!job.industryIds?.length) missing.push('industryIds');
    if (!job.seniority) missing.push('seniority');
    if (!job.experienceLevel) missing.push('experienceLevel');
    if (!job.applicationDeadline) missing.push('applicationDeadline');
    else if (job.applicationDeadline < this.today())
      missing.push('applicationDeadline');
    if (
      !job.salaryNegotiable &&
      (job.salaryMin == null || job.salaryMax == null)
    )
      missing.push('salaryRange');
    if (!hasMeaningfulRecruitmentHtml(job.description))
      missing.push('description');
    if (!hasMeaningfulRecruitmentHtml(job.requirements))
      missing.push('requirements');
    if (!hasMeaningfulRecruitmentHtml(job.benefits)) missing.push('benefits');
    if (!job.employmentType) missing.push('employmentType');
    if (!job.numberOfPositions || job.numberOfPositions < 1)
      missing.push('numberOfPositions');
    if (!job.workLocations?.length) missing.push('workLocations');
    if (!job.contactName?.trim()) missing.push('contactName');
    if (!job.contactEmail?.trim()) missing.push('contactEmail');
    if (!job.contactPhone?.trim()) missing.push('contactPhone');
    if (missing.length) {
      throw new BadRequestException({
        code: 'JOB_INCOMPLETE',
        message: 'Vị trí chưa đủ thông tin bắt buộc để công bố',
        missingFields: missing,
      });
    }
  }

  private today(): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
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
