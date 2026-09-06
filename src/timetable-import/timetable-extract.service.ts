import OpenAI from 'openai';
import {
    BadRequestException,
    Injectable,
    Logger,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';

import {
    EXTRACT_SYSTEM_PROMPT,
    EXTRACT_USER_PROMPT,
    TIMETABLE_SCHEMA,
} from './prompts/extract-timetable.prompt';
import { ExtractedTimetable } from './timetable.types';

/**
 * Giới hạn cạnh dài trước khi gửi ảnh lên mô hình. Ảnh lớn hơn được hạ sẵn
 * cho nhẹ payload — nhưng
 * **không** hạ thấp hơn: chữ số trong ô TKB nhỏ, mất pixel là mất chính xác ở
 * đúng chỗ khó đọc nhất.
 */
const MAX_IMAGE_EDGE = 2576;

const SUPPORTED_MIME = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
]);

export interface ExtractResult {
    data: ExtractedTimetable;
    usage: { inputTokens: number; outputTokens: number; model: string };
}

/**
 * Khâu duy nhất trong module có gọi mô hình ngôn ngữ: đọc ảnh → dữ liệu có cấu
 * trúc. Không truy cập database, không ghi gì — tách hẳn để phần ghi dữ liệu
 * chạy được và test được mà không cần API key.
 */
@Injectable()
export class TimetableExtractService {
    private readonly logger = new Logger(TimetableExtractService.name);
    private client?: OpenAI;

    constructor(private readonly config: ConfigService) {}

    private getClient(): OpenAI {
        if (this.client) return this.client;

        const apiKey = this.config.get<string>('OPENAI_API_KEY');
        if (!apiKey) {
            throw new ServiceUnavailableException({
                code: 'TIMETABLE_AI_NOT_CONFIGURED',
                message:
                    'Chưa cấu hình OPENAI_API_KEY nên không đọc được ảnh thời khoá biểu',
            });
        }

        this.client = new OpenAI({ apiKey });
        return this.client;
    }

    async extract(file: Express.Multer.File): Promise<ExtractResult> {
        const { data, mediaType } = await this.normalizeImage(file);
        const client = this.getClient();

        let response: OpenAI.Responses.Response;
        try {
            response = await client.responses.create({
                model:
                    this.config.get<string>('OPENAI_TIMETABLE_MODEL') ||
                    'gpt-5.6-terra',
                max_output_tokens: 16000,
                reasoning: { effort: 'medium' },
                instructions: EXTRACT_SYSTEM_PROMPT,
                text: {
                    format: {
                        type: 'json_schema',
                        name: 'extracted_timetable',
                        schema: TIMETABLE_SCHEMA,
                        strict: true,
                    },
                },
                input: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'input_image',
                                image_url: `data:${mediaType};base64,${data}`,
                                detail: 'high',
                            },
                            { type: 'input_text', text: EXTRACT_USER_PROMPT },
                        ],
                    },
                ],
            });
        } catch (error) {
            throw this.toHttpError(error);
        }

        return {
            data: this.parseResponse(response),
            usage: {
                inputTokens: response.usage?.input_tokens ?? 0,
                outputTokens: response.usage?.output_tokens ?? 0,
                model: response.model,
            },
        };
    }

    /**
     * `stop_reason` phải kiểm trước khi đọc `content`: khi bị từ chối, mảng
     * content rỗng (hoặc dở dang) nên `content[0]` sẽ nổ.
     */
    private parseResponse(
        response: OpenAI.Responses.Response,
    ): ExtractedTimetable {
        const refusal = response.output.some(
            (item) =>
                item.type === 'message' &&
                item.content.some((content) => content.type === 'refusal'),
        );
        if (refusal) {
            throw new ServiceUnavailableException({
                code: 'TIMETABLE_AI_REFUSED',
                message: 'Không xử lý được ảnh này. Vui lòng thử ảnh khác.',
            });
        }

        if (
            response.status === 'incomplete' &&
            response.incomplete_details?.reason === 'max_output_tokens'
        ) {
            throw new ServiceUnavailableException({
                code: 'TIMETABLE_AI_TRUNCATED',
                message:
                    'Thời khoá biểu quá lớn nên đọc chưa xong. Thử cắt ảnh thành từng phần nhỏ hơn.',
            });
        }

        const text = response.output_text;

        if (!text.trim()) {
            throw new ServiceUnavailableException({
                code: 'TIMETABLE_AI_EMPTY',
                message: 'Không đọc được nội dung nào từ ảnh',
            });
        }

        try {
            return JSON.parse(text) as ExtractedTimetable;
        } catch {
            // Structured outputs đảm bảo JSON hợp lệ nên nhánh này gần như
            // không xảy ra — giữ lại để lỗi hiện rõ thay vì crash ở nơi khác.
            this.logger.error(`Kết quả không phải JSON hợp lệ: ${text.slice(0, 500)}`);
            throw new ServiceUnavailableException({
                code: 'TIMETABLE_AI_INVALID',
                message: 'Kết quả đọc ảnh không hợp lệ',
            });
        }
    }

    /** Chuẩn hoá về JPEG ≤ 2576px cạnh dài; ảnh nhỏ hơn giữ nguyên kích thước. */
    private async normalizeImage(
        file: Express.Multer.File,
    ): Promise<{ data: string; mediaType: 'image/jpeg' }> {
        if (!file?.buffer?.length) {
            throw new BadRequestException({
                code: 'TIMETABLE_IMAGE_REQUIRED',
                message: 'Chưa chọn ảnh thời khoá biểu',
            });
        }

        if (!SUPPORTED_MIME.has(file.mimetype)) {
            throw new BadRequestException({
                code: 'TIMETABLE_IMAGE_TYPE_UNSUPPORTED',
                message: 'Chỉ hỗ trợ ảnh JPEG, PNG, WebP hoặc GIF',
            });
        }

        try {
            const image = sharp(file.buffer).rotate();
            const { width = 0, height = 0 } = await image.metadata();
            const longEdge = Math.max(width, height);

            const buffer = await (longEdge > MAX_IMAGE_EDGE
                ? image.resize({
                      width: width >= height ? MAX_IMAGE_EDGE : undefined,
                      height: height > width ? MAX_IMAGE_EDGE : undefined,
                  })
                : image
            )
                .jpeg({ quality: 90 })
                .toBuffer();

            return { data: buffer.toString('base64'), mediaType: 'image/jpeg' };
        } catch {
            throw new BadRequestException({
                code: 'TIMETABLE_IMAGE_INVALID',
                message: 'Không đọc được file ảnh',
            });
        }
    }

    private toHttpError(error: unknown): Error {
        if (error instanceof OpenAI.AuthenticationError) {
            return new ServiceUnavailableException({
                code: 'TIMETABLE_AI_UNAUTHORIZED',
                message: 'OPENAI_API_KEY không hợp lệ',
            });
        }
        if (error instanceof OpenAI.RateLimitError) {
            return new ServiceUnavailableException({
                code: 'TIMETABLE_AI_RATE_LIMITED',
                message: 'Hệ thống đang bận, vui lòng thử lại sau ít phút',
            });
        }
        if (error instanceof OpenAI.APIError) {
            this.logger.error(`OpenAI API ${error.status}: ${error.message}`);
            return new ServiceUnavailableException({
                code: 'TIMETABLE_AI_ERROR',
                message: 'Không đọc được ảnh thời khoá biểu, vui lòng thử lại',
            });
        }
        this.logger.error(error);
        return new ServiceUnavailableException({
            code: 'TIMETABLE_AI_ERROR',
            message: 'Không đọc được ảnh thời khoá biểu, vui lòng thử lại',
        });
    }
}
