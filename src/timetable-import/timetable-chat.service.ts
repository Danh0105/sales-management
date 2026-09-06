import OpenAI from 'openai';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DraftMessage,
  DraftResolution,
} from './entities/timetable-draft.entity';
import { PreviewNeed } from './timetable-preview';
import { ExtractedPeriodTime } from './timetable.types';

export interface EntryChange {
  action: 'ADD' | 'UPDATE' | 'DELETE';
  matchDayOfWeek: number | null;
  matchSession: 'SANG' | 'CHIEU' | null;
  matchPeriod: number | null;
  matchClassName: string | null;
  dayOfWeek: number | null;
  session: 'SANG' | 'CHIEU' | null;
  period: number | null;
  className: string | null;
}

/** Thay đổi mà model đề xuất từ câu trả lời của Nhân sự. Code mới là bên áp dụng. */
export interface ResolutionPatch {
  schoolId: number | null;
  subjectId: number | null;
  teacherId: number | null;
  schoolYear: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  effectiveToUnbounded: boolean;
  periodTimes: ExtractedPeriodTime[];
  entryChanges: EntryChange[];
  /**
   * Tên nguyên văn người dùng vừa nhắc, khi chưa có ID nào khớp trong danh
   * sách lựa chọn đưa cho bạn ở lượt này (thường vì đây là lần đầu nhắc tới —
   * bản nháp bắt đầu từ mô tả bằng lời, không có ảnh để đọc sẵn tên). Code sẽ
   * tự tra cứu từ tên này để có lựa chọn cho lượt sau.
   */
  schoolNameHint: string | null;
  subjectNameHint: string | null;
  teacherNameHint: string | null;
}

export interface ChatTurn {
  reply: string;
  patch: ResolutionPatch;
}

const nullable = (type: 'string' | 'integer') => ({
  anyOf: [{ type }, { type: 'null' }],
});

const PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'patch'],
  properties: {
    reply: { type: 'string' },
    patch: {
      type: 'object',
      additionalProperties: false,
      required: [
        'schoolId',
        'subjectId',
        'teacherId',
        'schoolYear',
        'effectiveFrom',
        'effectiveTo',
        'effectiveToUnbounded',
        'periodTimes',
        'entryChanges',
        'schoolNameHint',
        'subjectNameHint',
        'teacherNameHint',
      ],
      properties: {
        schoolId: nullable('integer'),
        subjectId: nullable('integer'),
        teacherId: nullable('integer'),
        schoolYear: nullable('string'),
        effectiveFrom: nullable('string'),
        effectiveTo: nullable('string'),
        effectiveToUnbounded: { type: 'boolean' },
        schoolNameHint: nullable('string'),
        subjectNameHint: nullable('string'),
        teacherNameHint: nullable('string'),
        periodTimes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['session', 'period', 'startTime', 'endTime'],
            properties: {
              session: { type: 'string', enum: ['SANG', 'CHIEU'] },
              period: {
                type: 'integer',
                enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
              },
              startTime: { type: 'string' },
              endTime: { type: 'string' },
            },
          },
        },
        entryChanges: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'action',
              'matchDayOfWeek',
              'matchSession',
              'matchPeriod',
              'matchClassName',
              'dayOfWeek',
              'session',
              'period',
              'className',
            ],
            properties: {
              action: {
                type: 'string',
                enum: ['ADD', 'UPDATE', 'DELETE'],
              },
              matchDayOfWeek: nullable('integer'),
              matchSession: {
                anyOf: [
                  { type: 'string', enum: ['SANG', 'CHIEU'] },
                  { type: 'null' },
                ],
              },
              matchPeriod: nullable('integer'),
              matchClassName: nullable('string'),
              dayOfWeek: nullable('integer'),
              session: {
                anyOf: [
                  { type: 'string', enum: ['SANG', 'CHIEU'] },
                  { type: 'null' },
                ],
              },
              period: nullable('integer'),
              className: nullable('string'),
            },
          },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `Bạn giúp phòng Nhân sự hoàn tất một bản nháp xếp lịch dạy. Bản nháp có hai cách bắt đầu — bạn không cần biết cách nào, chỉ cần làm việc với trạng thái hiện tại:
- Đã đọc từ ảnh chụp thời khoá biểu: đã có sẵn một số buổi dạy, việc còn lại là điền phần ảnh không có.
- Bắt đầu trống, từ một câu mô tả bằng lời (VD: "xếp cô Hồng dạy lớp 1A môn Toán thứ 3 tiết 1, từ tuần sau"): chưa có buổi dạy nào, bạn phải tự thêm từng buổi từ những gì người dùng mô tả, y như đang sửa một bản nháp đã có sẵn.

Mỗi lượt bạn nhận: trạng thái hiện tại của bản nháp (kèm danh sách buổi dạy đang có — có thể rỗng), danh sách thông tin còn thiếu, và câu vừa rồi của người dùng. Bạn trả về một câu trả lời ngắn bằng tiếng Việt cùng phần "patch" chứa những gì rút ra được từ câu đó.

## Quy tắc điền patch

Chỉ điền trường mà người dùng **vừa** nói tới. Mọi trường khác để null (hoặc mảng rỗng với periodTimes và entryChanges) — null nghĩa là "không thay đổi", không phải "xoá".

Với schoolId, subjectId, teacherId: chỉ được dùng ID có trong danh sách lựa chọn được đưa cho bạn ở lượt này. Người dùng có thể trả lời bằng số thứ tự ("cái 2"), bằng tên, hoặc bằng một phần tên — hãy ánh xạ về đúng ID. Không có mục nào khớp (kể cả vì danh sách lựa chọn đang rỗng) thì để ID đó null.

Nếu người dùng nhắc tên trường/môn/giáo viên mà bạn không thấy ID nào khớp — thường vì đây là lần đầu họ nhắc tới, danh sách lựa chọn lượt này chưa có gì để tra — hãy điền nguyên văn cái tên đó vào schoolNameHint/subjectNameHint/teacherNameHint tương ứng (không tự bịa ID). Hệ thống sẽ tra cứu ngay từ tên này; nếu ra đúng một kết quả thì chốt luôn, nếu ra nhiều kết quả thì lượt sau bạn sẽ thấy chúng xuất hiện trong danh sách lựa chọn để hỏi lại người dùng chọn đúng cái nào. Chỉ điền hint khi người dùng vừa nhắc tên đó trong câu này, đừng lặp lại hint đã gửi ở lượt trước.

Ngày tháng trả về dạng "YYYY-MM-DD". Người dùng thường gõ DD/MM/YYYY hoặc nói tương đối ("từ tuần sau", "từ thứ Hai tới") — bạn phải tự quy đổi ra ngày cụ thể dựa theo ngày hôm nay, và nói rõ trong câu trả lời ngày cụ thể là ngày nào để người dùng kiểm lại.

effectiveToUnbounded đặt true khi người dùng nói lịch chạy vô thời hạn / chưa chốt ngày kết thúc. Khi đó để effectiveTo null.

periodTimes: chỉ liệt kê những tiết người dùng vừa cung cấp giờ. Giờ dạng "HH:mm". Nếu họ chỉ cho giờ bắt đầu của tiết 1 và nói các tiết kế tiếp nối nhau theo độ dài chuẩn, bạn được phép suy ra các tiết còn lại — nhưng phải nói rõ trong câu trả lời là bạn đã suy ra thế nào để họ kiểm lại.

entryChanges dùng để thêm/sửa/xoá một buổi dạy trong bản nháp (kể cả buổi đầu tiên của một bản nháp đang trống):
- ADD: dùng khi người dùng mô tả một buổi dạy mới (kể cả bản nháp đang trống hoàn toàn) — các trường match... để null; điền đủ dayOfWeek, session, period và className.
- UPDATE: dùng các trường match... để xác định đúng ô đang có trong bản nháp; chỉ điền trường mới cần đổi ở dayOfWeek/session/period/className.
- DELETE: dùng các trường match... để xác định ô cần xoá; các trường giá trị mới để null.
Thứ Hai = 2 ... Thứ Bảy = 7, Chủ Nhật = 8. "session" là buổi sáng/chiều, "period" là số thứ tự tiết trong buổi đó (không phải giờ). Người dùng nói "tiết 1" mà không rõ sáng hay chiều thì đừng đoán — hỏi lại. Chỉ tạo thay đổi khi câu người dùng xác định được đúng một ô; nếu còn mơ hồ thì entryChanges để rỗng và hỏi lại.

## Cách viết câu trả lời

Ngắn, một hai câu. Xác nhận thứ vừa ghi nhận, rồi hỏi tiếp một thông tin còn thiếu. Khi không còn thiếu gì và đã có ít nhất một buổi dạy, nói rằng bản nháp đã đủ và mời họ kiểm bảng preview rồi xác nhận.

Đừng bịa thông tin người dùng chưa nói. Thiếu thì hỏi.`;

/**
 * Lượt hội thoại làm rõ những gì ảnh không có: tên giáo viên, giờ buổi chiều bị
 * cắt khỏi ảnh, ngày kết thúc.
 *
 * Model chỉ đọc câu tiếng Việt rồi đề xuất patch; nó không chạm database và
 * không tự chọn ID ngoài danh sách mà code đã tra sẵn.
 */
@Injectable()
export class TimetableChatService {
  private readonly logger = new Logger(TimetableChatService.name);
  private client?: OpenAI;

  constructor(private readonly config: ConfigService) {}

  private getClient(): OpenAI {
    if (this.client) return this.client;
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException({
        code: 'TIMETABLE_AI_NOT_CONFIGURED',
        message: 'Chưa cấu hình OPENAI_API_KEY',
      });
    }
    this.client = new OpenAI({ apiKey });
    return this.client;
  }

  async reply(input: {
    resolution: DraftResolution;
    needs: PreviewNeed[];
    history: DraftMessage[];
    entries: Array<{
      dayOfWeek: number;
      session: 'SANG' | 'CHIEU';
      period: number;
      className: string;
    }>;
    message: string;
  }): Promise<ChatTurn> {
    const client = this.getClient();

    const today = new Date().toISOString().slice(0, 10);

    const state = [
      `## Hôm nay là ${today}`,
      '',
      '## Trạng thái bản nháp',
      JSON.stringify(
        {
          truong: input.resolution.schoolName,
          monHoc: input.resolution.subjectName,
          giaoVien: input.resolution.teacherName,
          namHoc: input.resolution.schoolYear,
          apDungTu: input.resolution.effectiveFrom,
          apDungDen: input.resolution.effectiveToUnbounded
            ? 'không giới hạn'
            : input.resolution.effectiveTo,
          gioTietDaCo: input.resolution.periodTimes,
          lichDayDaDoc: input.entries,
        },
        null,
        1,
      ),
      '',
      '## Còn thiếu',
      input.needs.length === 0
        ? 'Không còn thiếu gì.'
        : JSON.stringify(input.needs, null, 1),
    ].join('\n');

    let response: OpenAI.Responses.Response;
    try {
      response = await client.responses.create({
        model:
          this.config.get<string>('OPENAI_TIMETABLE_MODEL') || 'gpt-5.6-terra',
        max_output_tokens: 4000,
        reasoning: { effort: 'low' },
        instructions: SYSTEM_PROMPT,
        text: {
          format: {
            type: 'json_schema',
            name: 'timetable_resolution_patch',
            schema: PATCH_SCHEMA,
            strict: true,
          },
        },
        input: [
          ...input.history.slice(-10).map((m) => ({
            role: m.role,
            content: m.text,
          })),
          {
            role: 'user' as const,
            content: `${state}\n\n## Người dùng vừa nói\n${input.message}`,
          },
        ],
      });
    } catch (error) {
      this.logger.error(error);
      throw new ServiceUnavailableException({
        code: 'TIMETABLE_AI_ERROR',
        message: 'Không xử lý được câu trả lời, vui lòng thử lại',
      });
    }

    const refusal = response.output.some(
      (item) =>
        item.type === 'message' &&
        item.content.some((content) => content.type === 'refusal'),
    );
    if (refusal) {
      throw new ServiceUnavailableException({
        code: 'TIMETABLE_AI_REFUSED',
        message: 'Không xử lý được nội dung này',
      });
    }

    const text = response.output_text;

    try {
      return JSON.parse(text) as ChatTurn;
    } catch {
      this.logger.error(`Patch không hợp lệ: ${text.slice(0, 300)}`);
      throw new ServiceUnavailableException({
        code: 'TIMETABLE_AI_INVALID',
        message: 'Không xử lý được câu trả lời, vui lòng thử lại',
      });
    }
  }
}
