import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toFile } from 'openai';

import {
  DEFAULT_TRYON_MODEL,
  DEFAULT_TRYON_SIZE,
  TryOnSize,
} from './virtual-tryon.constants';

export interface TryOnGenerateInput {
  personImage: Buffer;
  garmentImage: Buffer;
  prompt: string;
  model: string;
  size: TryOnSize;
}

export interface TryOnGenerateResult {
  /** Ảnh kết quả, base64 PNG do mô hình trả về. */
  base64: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

/**
 * Khâu duy nhất có gọi mô hình sinh ảnh. Không đụng database, không ghi file —
 * để phần điều phối job chạy và test được mà không cần API key (cùng lối tách
 * với `TimetableExtractService`).
 */
@Injectable()
export class VirtualTryOnOpenAiService {
  private readonly logger = new Logger(VirtualTryOnOpenAiService.name);
  private client?: OpenAI;

  constructor(private readonly config: ConfigService) {}

  get defaultModel(): string {
    return (
      this.config.get<string>('VIRTUAL_TRYON_MODEL')?.trim() ||
      DEFAULT_TRYON_MODEL
    );
  }

  get defaultSize(): TryOnSize {
    return (
      (this.config.get<string>('VIRTUAL_TRYON_SIZE')?.trim() as TryOnSize) ||
      DEFAULT_TRYON_SIZE
    );
  }

  private getClient(): OpenAI {
    if (this.client) return this.client;

    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException({
        code: 'TRYON_AI_NOT_CONFIGURED',
        message: 'Chưa cấu hình OPENAI_API_KEY nên không tạo được ảnh thử đồ',
      });
    }

    this.client = new OpenAI({ apiKey });
    return this.client;
  }

  /**
   * Thứ tự ảnh có ý nghĩa: ảnh người trước, ảnh trang phục sau — prompt mặc
   * định gọi thẳng "ảnh 1"/"ảnh 2" theo đúng thứ tự này.
   */
  async generate(input: TryOnGenerateInput): Promise<TryOnGenerateResult> {
    const client = this.getClient();
    const startedAt = Date.now();

    const response = await client.images.edit({
      model: input.model,
      image: [
        await toFile(input.personImage, 'person.webp', { type: 'image/webp' }),
        await toFile(input.garmentImage, 'garment.webp', { type: 'image/webp' }),
      ],
      prompt: input.prompt,
      size: input.size,
    });

    const durationMs = Date.now() - startedAt;
    const base64 = response.data?.[0]?.b64_json;

    if (!base64) {
      throw new ServiceUnavailableException({
        code: 'TRYON_RESULT_EMPTY',
        message: 'Mô hình không trả về ảnh, vui lòng thử lại',
      });
    }

    this.logger.log(
      `Thử đồ ảo: model=${input.model} size=${input.size} ${durationMs}ms ` +
        `tokens=${response.usage?.input_tokens ?? '?'}/${response.usage?.output_tokens ?? '?'}`,
    );

    return {
      base64,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      durationMs,
    };
  }
}
