import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';

import type {
  AiFindOrCreateCandidateDto,
  AiUpdateCandidateDto,
} from '../dto/ai.dto';
import type {
  CandidateProfileDto,
  CreateCandidateDto,
  QueryCandidateDto,
  UpdateCandidateDto,
} from '../dto/candidate.dto';
import type { Paginated } from '../dto/common.dto';
import { RecruitmentApplication } from '../entities/recruitment-application.entity';
import { RecruitmentCandidate } from '../entities/recruitment-candidate.entity';
import { RecruitmentAuditService } from '../recruitment-audit.service';
import { CandidateSource } from '../recruitment.enums';
import { AI_ACTOR, type RecruitmentActor } from '../recruitment.roles';
import {
  isUniqueViolation,
  likePattern,
  toAiCandidateView,
} from '../recruitment.views';
import { normalizeEmail, normalizePhone } from '../utils/text-normalize';

export type DuplicateMatchField = 'phone' | 'email';

export interface DuplicateMatch {
  candidate: RecruitmentCandidate;
  matchedOn: DuplicateMatchField[];
}

export type AiFindOrCreateCandidateResult =
  | {
      outcome: 'EXISTING' | 'CREATED';
      created: boolean;
      candidate: ReturnType<typeof toAiCandidateView>;
      suspectedDuplicate: boolean;
    }
  | {
      outcome: 'POSSIBLE_DUPLICATE';
      created: false;
      candidate: null;
      matchedOn: DuplicateMatchField[];
      possibleDuplicateCount: number;
      message: string;
    };

@Injectable()
export class RecruitmentCandidateService {
  constructor(
    @InjectRepository(RecruitmentCandidate)
    private readonly candidateRepo: Repository<RecruitmentCandidate>,
    @InjectRepository(RecruitmentApplication)
    private readonly applicationRepo: Repository<RecruitmentApplication>,
    private readonly audit: RecruitmentAuditService,
  ) {}

  // ---------------------------------------------------------------- HR ----

  async create(dto: CreateCandidateDto, actor: RecruitmentActor) {
    const identity = this.normalizeIdentity(dto);
    if (dto.zaloUserId) await this.assertZaloFree(dto.zaloUserId);

    const duplicates = await this.findDuplicates(identity);
    if (duplicates.length && !dto.allowDuplicate) {
      throw this.duplicateConflict(duplicates);
    }

    const candidate = this.candidateRepo.create({
      zaloUserId: dto.zaloUserId ?? null,
      source: dto.source ?? CandidateSource.MANUAL,
      notes: dto.notes ?? null,
      skills: [],
      metadata: {},
      suspectedDuplicateIds: duplicates.map((d) => d.candidate.id),
    });
    this.applyProfile(candidate, dto, identity);

    const saved = await this.saveHandlingZalo(candidate);
    await this.audit.record({
      actor,
      action: 'CANDIDATE_CREATE',
      entity: 'candidates',
      entityId: saved.id,
      after: saved,
    });
    return saved;
  }

  async findAll(
    query: QueryCandidateDto,
  ): Promise<Paginated<RecruitmentCandidate>> {
    const { page, limit } = query;
    const qb = this.candidateRepo.createQueryBuilder('c');

    if (query.keyword) {
      const kw = likePattern(query.keyword);
      const phone = normalizePhone(query.keyword);
      qb.andWhere(
        new Brackets((w) => {
          w.where('c.fullName ILIKE :kw', { kw })
            .orWhere('c.email ILIKE :kw', { kw })
            .orWhere('c.phone LIKE :kw', { kw });
          if (phone) w.orWhere('c.phone = :phone', { phone });
        }),
      );
    }
    if (query.source)
      qb.andWhere('c.source = :source', { source: query.source });
    if (query.deletionRequested !== undefined) {
      qb.andWhere(
        query.deletionRequested
          ? 'c.deletionRequestedAt IS NOT NULL'
          : 'c.deletionRequestedAt IS NULL',
      );
    }
    if (query.suspectedDuplicate !== undefined) {
      qb.andWhere(
        query.suspectedDuplicate
          ? 'cardinality(c.suspectedDuplicateIds) > 0'
          : 'cardinality(c.suspectedDuplicateIds) = 0',
      );
    }

    const [data, total] = await qb
      .orderBy('c.createdAt', 'DESC')
      .addOrderBy('c.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data, total, page, limit };
  }

  async findOne(id: number) {
    const candidate = await this.getOrThrow(id);
    const applications = await this.applicationRepo.find({
      where: { candidateId: id },
      relations: { job: true },
      order: { createdAt: 'DESC' },
    });
    return {
      ...candidate,
      applications: applications.map((a) => ({
        id: a.id,
        status: a.status,
        aiMatchScore: a.aiMatchScore,
        aiMatchLevel: a.aiMatchLevel,
        aiPaused: a.aiPaused,
        createdAt: a.createdAt,
        job: a.job
          ? { id: a.job.id, code: a.job.code, title: a.job.title }
          : null,
      })),
    };
  }

  async update(id: number, dto: UpdateCandidateDto, actor: RecruitmentActor) {
    const candidate = await this.getOrThrow(id);
    const before = { ...candidate };
    const identity = this.normalizeIdentity(dto);

    if (
      dto.zaloUserId !== undefined &&
      dto.zaloUserId !== candidate.zaloUserId
    ) {
      if (dto.zaloUserId) await this.assertZaloFree(dto.zaloUserId, id);
      candidate.zaloUserId = dto.zaloUserId ?? null;
    }

    const duplicates = await this.findDuplicates(
      this.changedIdentity(candidate, identity),
      id,
    );
    if (duplicates.length && !dto.allowDuplicate) {
      throw this.duplicateConflict(duplicates);
    }
    this.addSuspected(candidate, duplicates);

    if (dto.source) candidate.source = dto.source;
    if (dto.notes !== undefined) candidate.notes = dto.notes ?? null;
    this.applyProfile(candidate, dto, identity);

    const saved = await this.saveHandlingZalo(candidate);
    await this.audit.record({
      actor,
      action: 'CANDIDATE_UPDATE',
      entity: 'candidates',
      entityId: id,
      before,
      after: saved,
    });
    return saved;
  }

  // ---------------------------------------------------------------- AI ----

  /**
   * Idempotent khi OpenClaw retry: cùng `zaloUserId` luôn ra cùng ứng viên,
   * kể cả hai request chạy song song (unique index + bắt lỗi 23505).
   *
   * SĐT/email trùng **không** trả hồ sơ cũ: người nhắn có thể khai SĐT của
   * người khác để đọc hồ sơ của họ. Chỉ báo `POSSIBLE_DUPLICATE`, không kèm id
   * hay thông tin gì của hồ sơ kia; HR đối chiếu và gộp tay.
   */
  async aiFindOrCreate(
    dto: AiFindOrCreateCandidateDto,
  ): Promise<AiFindOrCreateCandidateResult> {
    if (!dto.zaloUserId && !dto.phone && !dto.email) {
      throw new BadRequestException({
        code: 'IDENTITY_REQUIRED',
        message: 'Cần ít nhất một trong zaloUserId, phone, email',
      });
    }
    const identity = this.normalizeIdentity(dto);

    if (dto.zaloUserId) {
      const existing = await this.candidateRepo.findOne({
        where: { zaloUserId: dto.zaloUserId },
      });
      if (existing) return this.existingResult(existing);
    }

    const duplicates = await this.findDuplicates(identity);
    if (duplicates.length && !dto.confirmNewCandidate) {
      const matchedOn = [...new Set(duplicates.flatMap((d) => d.matchedOn))];
      return {
        outcome: 'POSSIBLE_DUPLICATE',
        created: false,
        candidate: null,
        matchedOn,
        possibleDuplicateCount: duplicates.length,
        message:
          'Thông tin liên hệ trùng với hồ sơ đã có. Không thể tự nhận hồ sơ đó — ' +
          'gửi lại với confirmNewCandidate=true để tạo hồ sơ mới (HR sẽ đối chiếu), ' +
          'hoặc chuyển HR.',
      };
    }

    const candidate = this.candidateRepo.create({
      zaloUserId: dto.zaloUserId ?? null,
      source:
        dto.source ??
        (dto.zaloUserId ? CandidateSource.ZALO : CandidateSource.OTHER),
      fullName: dto.fullName ?? null,
      location: dto.location ?? null,
      phone: identity.phone ?? null,
      email: identity.email ?? null,
      skills: [],
      metadata: {},
      suspectedDuplicateIds: duplicates.map((d) => d.candidate.id),
    });

    let saved: RecruitmentCandidate;
    try {
      saved = await this.candidateRepo.save(candidate);
    } catch (error) {
      if (isUniqueViolation(error) && dto.zaloUserId) {
        const raced = await this.candidateRepo.findOne({
          where: { zaloUserId: dto.zaloUserId },
        });
        if (raced) return this.existingResult(raced);
      }
      throw error;
    }

    await this.audit.record({
      actor: AI_ACTOR,
      action: 'CANDIDATE_CREATE',
      entity: 'candidates',
      entityId: saved.id,
      after: saved,
      context: { suspectedDuplicate: duplicates.length > 0 },
    });
    return {
      outcome: 'CREATED',
      created: true,
      candidate: toAiCandidateView(saved),
      suspectedDuplicate: duplicates.length > 0,
    };
  }

  async aiGet(id: number) {
    return toAiCandidateView(await this.getOrThrow(id));
  }

  /**
   * SĐT/email mới trùng hồ sơ khác: vẫn lưu (không chặn hội thoại) nhưng gắn
   * cờ nghi trùng cho HR và báo lại cho AI — không kèm thông tin hồ sơ kia.
   */
  async aiUpdate(id: number, dto: AiUpdateCandidateDto) {
    const candidate = await this.getOrThrow(id);
    if (candidate.aiStoppedAt) {
      throw new ConflictException({
        code: 'AI_STOPPED_FOR_CANDIDATE',
        message:
          'Ứng viên đã yêu cầu xoá dữ liệu — AI dừng xử lý, HR sẽ liên hệ trực tiếp',
      });
    }
    const before = { ...candidate };
    const identity = this.normalizeIdentity(dto);

    const duplicates = await this.findDuplicates(
      this.changedIdentity(candidate, identity),
      id,
    );
    this.addSuspected(candidate, duplicates);
    this.applyProfile(candidate, dto, identity);

    const saved = await this.candidateRepo.save(candidate);
    await this.audit.record({
      actor: AI_ACTOR,
      action: 'CANDIDATE_UPDATE',
      entity: 'candidates',
      entityId: id,
      before,
      after: saved,
    });
    return {
      candidate: toAiCandidateView(saved),
      possibleDuplicate: duplicates.length > 0,
      matchedOn: [...new Set(duplicates.flatMap((d) => d.matchedOn))],
    };
  }

  // ----------------------------------------------------------- helpers ----

  async getOrThrow(id: number): Promise<RecruitmentCandidate> {
    const candidate = await this.candidateRepo.findOne({ where: { id } });
    if (!candidate) {
      throw new NotFoundException({
        code: 'CANDIDATE_NOT_FOUND',
        message: `Không tìm thấy ứng viên #${id}`,
      });
    }
    return candidate;
  }

  /** Ứng viên khác có cùng SĐT hoặc email. */
  async findDuplicates(
    identity: { phone?: string | null; email?: string | null },
    excludeId?: number,
  ): Promise<DuplicateMatch[]> {
    const { phone, email } = identity;
    if (!phone && !email) return [];

    const qb = this.candidateRepo.createQueryBuilder('c').where(
      new Brackets((w) => {
        if (phone) w.orWhere('c.phone = :phone', { phone });
        if (email) w.orWhere('c.email = :email', { email });
      }),
    );
    if (excludeId) qb.andWhere('c.id <> :excludeId', { excludeId });

    const rows = await qb.orderBy('c.id', 'ASC').take(20).getMany();
    return rows.map((candidate) => ({
      candidate,
      matchedOn: [
        ...(phone && candidate.phone === phone ? (['phone'] as const) : []),
        ...(email && candidate.email === email ? (['email'] as const) : []),
      ],
    }));
  }

  /** `phone` có gửi mà không phải số VN hợp lệ → 400 thay vì lưu bừa. */
  private normalizeIdentity(dto: {
    phone?: string | null;
    email?: string | null;
  }) {
    let phone: string | null | undefined = undefined;
    if (dto.phone !== undefined) {
      phone = dto.phone === null ? null : normalizePhone(dto.phone);
      if (dto.phone !== null && !phone) {
        throw new BadRequestException({
          code: 'INVALID_PHONE',
          message: `Số điện thoại "${dto.phone}" không hợp lệ`,
        });
      }
    }
    const email =
      dto.email === undefined ? undefined : normalizeEmail(dto.email);
    return { phone, email };
  }

  /** Chỉ kiểm trùng phần SĐT/email thực sự đổi — tránh báo lại cờ cũ mỗi lần sửa. */
  private changedIdentity(
    candidate: RecruitmentCandidate,
    identity: { phone?: string | null; email?: string | null },
  ) {
    return {
      phone:
        identity.phone && identity.phone !== candidate.phone
          ? identity.phone
          : null,
      email:
        identity.email && identity.email !== candidate.email
          ? identity.email
          : null,
    };
  }

  private addSuspected(
    candidate: RecruitmentCandidate,
    duplicates: DuplicateMatch[],
  ) {
    if (!duplicates.length) return;
    candidate.suspectedDuplicateIds = [
      ...new Set([
        ...(candidate.suspectedDuplicateIds ?? []),
        ...duplicates.map((d) => d.candidate.id),
      ]),
    ];
  }

  private applyProfile(
    candidate: RecruitmentCandidate,
    dto: CandidateProfileDto,
    identity: { phone?: string | null; email?: string | null },
  ) {
    const set = <K extends keyof RecruitmentCandidate>(
      key: K,
      value: unknown,
    ) => {
      if (value !== undefined)
        candidate[key] = value as RecruitmentCandidate[K];
    };
    set('fullName', dto.fullName);
    set('phone', identity.phone);
    set('email', identity.email);
    set('location', dto.location);
    set('education', dto.education);
    set('experienceSummary', dto.experienceSummary);
    set('totalExperienceMonths', dto.totalExperienceMonths);
    set('currentJob', dto.currentJob);
    set('expectedSalary', dto.expectedSalary);
    set('availableFrom', dto.availableFrom);
    set('cvUrl', dto.cvUrl);
    if (dto.skills !== undefined) candidate.skills = dto.skills ?? [];
    if (dto.metadata !== undefined) candidate.metadata = dto.metadata ?? {};
  }

  private async assertZaloFree(zaloUserId: string, excludeId?: number) {
    const existing = await this.candidateRepo.findOne({
      where: { zaloUserId },
    });
    if (existing && existing.id !== excludeId) {
      throw new ConflictException({
        code: 'CANDIDATE_ZALO_EXISTS',
        message: 'zaloUserId đã thuộc về ứng viên khác',
        candidateId: existing.id,
      });
    }
  }

  private duplicateConflict(duplicates: DuplicateMatch[]) {
    return new ConflictException({
      code: 'POSSIBLE_DUPLICATE',
      message:
        'Có ứng viên trùng SĐT/email. Kiểm tra trước, hoặc gửi allowDuplicate=true để vẫn tạo.',
      duplicates: duplicates.map((d) => ({
        id: d.candidate.id,
        fullName: d.candidate.fullName,
        phone: d.candidate.phone,
        email: d.candidate.email,
        source: d.candidate.source,
        matchedOn: d.matchedOn,
      })),
    });
  }

  private existingResult(
    candidate: RecruitmentCandidate,
  ): AiFindOrCreateCandidateResult {
    return {
      outcome: 'EXISTING',
      created: false,
      candidate: toAiCandidateView(candidate),
      suspectedDuplicate: (candidate.suspectedDuplicateIds ?? []).length > 0,
    };
  }

  private async saveHandlingZalo(candidate: RecruitmentCandidate) {
    try {
      return await this.candidateRepo.save(candidate);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'CANDIDATE_ZALO_EXISTS',
          message: 'zaloUserId đã thuộc về ứng viên khác',
        });
      }
      throw error;
    }
  }
}
