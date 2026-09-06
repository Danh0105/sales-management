import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { In, Repository } from 'typeorm';

import { VirtualTryOnJob } from './entities/virtual-tryon-job.entity';
import { VirtualTryOnOpenAiService } from './virtual-tryon-openai.service';
import { VirtualTryOnStorageService } from './virtual-tryon-storage.service';
import {
  CreateVirtualTryOnDto,
  QueryVirtualTryOnDto,
} from './dto/virtual-tryon.dto';
import { DEFAULT_TRYON_PROMPT, TryOnSize } from './virtual-tryon.constants';
import { TryOnJobStatus } from './virtual-tryon.enum';

const MAX_LIMIT = 100;

/** Ai đang xem/xoá job: theo tài khoản đăng nhập, hoặc theo token ẩn danh. */
export interface TryOnAccess {
  viewerId?: number | null;
  canViewAll?: boolean;
  token?: string | null;
}

/**
 * So sánh chuỗi theo thời gian hằng định — tránh dò token qua chênh lệch thời
 * gian phản hồi. Khác độ dài thì trả false luôn (độ dài không phải bí mật).
 */
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

@Injectable()
export class VirtualTryOnService implements OnModuleInit {
  private readonly logger = new Logger(VirtualTryOnService.name);

  constructor(
    @InjectRepository(VirtualTryOnJob)
    private readonly jobRepo: Repository<VirtualTryOnJob>,

    private readonly openai: VirtualTryOnOpenAiService,
    private readonly storage: VirtualTryOnStorageService,
  ) {}

  /**
   * Job đang chạy dở nằm trong RAM của tiến trình; deploy/restart giữa chừng là
   * mất hẳn, không ai chạy tiếp. Đánh dấu FAILED ngay lúc khởi động để client
   * đang polling biết đường dừng và tạo lại, thay vì chờ vô hạn ở PROCESSING.
   */
  async onModuleInit() {
    const stuck = await this.jobRepo.find({
      where: { status: In([TryOnJobStatus.PENDING, TryOnJobStatus.PROCESSING]) },
      select: ['id'],
    });

    if (!stuck.length) return;

    await this.jobRepo.update(
      { id: In(stuck.map((job) => job.id)) },
      {
        status: TryOnJobStatus.FAILED,
        errorCode: 'TRYON_INTERRUPTED',
        errorMessage:
          'Dịch vụ khởi động lại khi đang xử lý, vui lòng tạo lại yêu cầu',
        finishedAt: new Date(),
      },
    );
    this.logger.warn(
      `Đánh dấu FAILED ${stuck.length} job thử đồ bị gián đoạn do restart`,
    );
  }

  /**
   * Nhận ảnh, tạo job rồi trả về NGAY — việc gọi mô hình chạy nền vì mất
   * 10–60s, giữ kết nối HTTP chờ chừng đó sẽ chạm timeout của nginx/proxy.
   */
  async create(
    files: { person: Express.Multer.File; garment: Express.Multer.File },
    dto: CreateVirtualTryOnDto,
    createdBy?: number | null,
  ) {
    const personImageUrl = await this.storage.storeUpload(files.person, 'person');
    let garmentImageUrl: string;
    try {
      garmentImageUrl = await this.storage.storeUpload(files.garment, 'garment');
    } catch (error) {
      // Ảnh đầu đã ghi xuống đĩa rồi thì phải dọn, không để lại file mồ côi.
      await this.storage.remove(personImageUrl);
      throw error;
    }

    // Khách chưa đăng nhập nhận token để về sau còn xem/xoá đúng job của mình.
    const publicToken = createdBy ? null : randomBytes(24).toString('hex');

    const job = await this.jobRepo.save(
      this.jobRepo.create({
        status: TryOnJobStatus.PENDING,
        personImageUrl,
        garmentImageUrl,
        prompt: dto.prompt?.trim() || DEFAULT_TRYON_PROMPT,
        model: this.openai.defaultModel,
        size: (dto.size as TryOnSize) || this.openai.defaultSize,
        createdBy: createdBy ?? null,
        publicToken,
      }),
    );

    // Cố ý không await: response trả về ngay, client hỏi lại qua GET /:id.
    void this.process(job.id);

    // Token chỉ xuất hiện đúng một lần ở response tạo job; các API sau không
    // trả lại nữa để không rò qua màn danh sách của người khác.
    return { ...this.toItem(job), publicToken };
  }

  /** Chạy nền — mọi lỗi được ghi vào chính job, không văng ra ngoài. */
  private async process(jobId: number): Promise<void> {
    try {
      const job = await this.jobRepo.findOne({ where: { id: jobId } });
      if (!job || job.status !== TryOnJobStatus.PENDING) return;

      await this.jobRepo.update(jobId, { status: TryOnJobStatus.PROCESSING });

      const [personImage, garmentImage] = await Promise.all([
        this.storage.read(job.personImageUrl),
        this.storage.read(job.garmentImageUrl),
      ]);

      const result = await this.openai.generate({
        personImage,
        garmentImage,
        prompt: job.prompt,
        model: job.model,
        size: job.size as TryOnSize,
      });

      const resultImageUrl = await this.storage.storeResult(result.base64);

      await this.jobRepo.update(jobId, {
        status: TryOnJobStatus.SUCCEEDED,
        resultImageUrl,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        errorCode: null,
        errorMessage: null,
        finishedAt: new Date(),
      });
    } catch (error) {
      const { code, message } = this.describeError(error);
      this.logger.error(`Job thử đồ #${jobId} lỗi: ${code} - ${message}`);

      await this.jobRepo
        .update(jobId, {
          status: TryOnJobStatus.FAILED,
          errorCode: code,
          errorMessage: message,
          finishedAt: new Date(),
        })
        .catch((updateError) =>
          this.logger.error(
            `Không ghi được lỗi cho job #${jobId}: ${(updateError as Error).message}`,
          ),
        );
    }
  }

  /**
   * Quy lỗi về cặp `code` ổn định + câu tiếng Việt hiển thị được. Lỗi từ
   * OpenAI trả về nguyên văn tiếng Anh và có thể lộ chi tiết cấu hình nên
   * không đưa thẳng cho người dùng.
   */
  private describeError(error: unknown): { code: string; message: string } {
    const response = (error as any)?.response;
    const status = (error as any)?.status ?? response?.status;
    const payload = (error as any)?.response?.data ?? (error as any)?.error;
    const detail =
      typeof payload?.error?.message === 'string'
        ? payload.error.message
        : (error as Error)?.message;

    if (status === 400 || status === 422) {
      return {
        code: 'TRYON_INPUT_REJECTED',
        message:
          'Mô hình từ chối ảnh đầu vào (có thể do nội dung không phù hợp hoặc ảnh không rõ). Thử ảnh khác giúp.',
      };
    }
    if (status === 401 || status === 403) {
      return {
        code: 'TRYON_AI_NOT_CONFIGURED',
        message: 'Cấu hình OpenAI không hợp lệ, cần kiểm tra lại API key',
      };
    }
    if (status === 429) {
      return {
        code: 'TRYON_RATE_LIMITED',
        message: 'Đang quá tải hoặc hết hạn mức OpenAI, thử lại sau ít phút',
      };
    }

    const known = (error as any)?.response?.code || (error as any)?.code;
    if (typeof known === 'string' && known.startsWith('TRYON_')) {
      return { code: known, message: (error as any).message ?? detail };
    }

    return {
      code: 'TRYON_FAILED',
      message: detail || 'Tạo ảnh thử đồ thất bại',
    };
  }

  /**
   * Xem một job. Ai được xem:
   * - vai trò quản lý (`canViewAll`),
   * - chính người tạo (khi đã đăng nhập),
   * - hoặc khách ẩn danh kèm đúng `publicToken` đã cấp lúc tạo.
   */
  async findOne(id: number, access: TryOnAccess = {}) {
    const job = await this.getAccessibleJob(id, access);
    return this.toItem(job);
  }

  private async getAccessibleJob(id: number, access: TryOnAccess) {
    const job = await this.jobRepo.findOne({ where: { id } });
    if (!job) throw new NotFoundException('Không tìm thấy yêu cầu thử đồ');

    const byRole = access.canViewAll === true;
    const byOwner =
      access.viewerId != null && job.createdBy === access.viewerId;
    const byToken =
      !!job.publicToken &&
      !!access.token &&
      timingSafeEqualString(job.publicToken, access.token);

    if (!byRole && !byOwner && !byToken) {
      // Không phân biệt "không có quyền" với "không tồn tại" — tránh để người
      // ngoài dò được job của người khác qua mã trả về.
      throw new NotFoundException('Không tìm thấy yêu cầu thử đồ');
    }

    return job;
  }

  async findAll(query: QueryVirtualTryOnDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, MAX_LIMIT);

    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.createdBy) where.createdBy = query.createdBy;

    const [rows, total] = await this.jobRepo.findAndCount({
      where,
      order: { id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      data: rows.map((row) => this.toItem(row)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  /** Xoá job kèm mọi ảnh đã lưu — không để file mồ côi trên đĩa. */
  async remove(id: number, access: TryOnAccess = {}) {
    const job = await this.getAccessibleJob(id, access);

    await this.jobRepo.delete(id);
    await Promise.all([
      this.storage.remove(job.personImageUrl),
      this.storage.remove(job.garmentImageUrl),
      this.storage.remove(job.resultImageUrl),
    ]);

    return { deleted: true };
  }

  private toItem(job: VirtualTryOnJob) {
    return {
      id: job.id,
      status: job.status,
      personImageUrl: this.storage.publicUrl(job.personImageUrl),
      garmentImageUrl: this.storage.publicUrl(job.garmentImageUrl),
      resultImageUrl: this.storage.publicUrl(job.resultImageUrl),
      prompt: job.prompt,
      model: job.model,
      size: job.size,
      errorCode: job.errorCode ?? null,
      errorMessage: job.errorMessage ?? null,
      inputTokens: job.inputTokens ?? null,
      outputTokens: job.outputTokens ?? null,
      durationMs: job.durationMs ?? null,
      createdBy: job.createdBy ?? null,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt ?? null,
    };
  }
}
