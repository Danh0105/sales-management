import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  CandidateSource,
  ConversationChannel,
  HandoffPriority,
  HandoffReason,
  MessageContentType,
  MessageDirection,
  MessageSenderType,
} from '../recruitment.enums';
import { CandidateProfileDto, ZALO_USER_ID } from './candidate.dto';
import { DATE_ONLY, IsSafeMetadata, Trim, TrimEach } from './common.dto';

const MAX_MONEY = 1_000_000_000_000;

/**
 * Tìm hoặc tạo ứng viên. Phải có ít nhất một trong `zaloUserId`, `phone`,
 * `email`. Chỉ `zaloUserId` được dùng để nhận lại ứng viên cũ — SĐT/email
 * trùng chỉ trả `POSSIBLE_DUPLICATE`, không bao giờ trả hồ sơ cũ.
 */
export class AiFindOrCreateCandidateDto {
  @IsOptional()
  @Matches(ZALO_USER_ID, { message: 'zaloUserId không hợp lệ' })
  zaloUserId?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @Trim()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(255)
  fullName?: string;

  @IsOptional()
  @IsEnum(CandidateSource)
  source?: CandidateSource;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(255)
  location?: string;

  /**
   * Gửi lại với `true` sau khi nhận `POSSIBLE_DUPLICATE` để vẫn tạo ứng viên
   * mới (bị gắn cờ nghi trùng chờ HR đối chiếu).
   */
  @IsOptional()
  @IsBoolean()
  confirmNewCandidate?: boolean;
}

/** AI cập nhật hồ sơ: không sửa được `zaloUserId`, nguồn hay ghi chú nội bộ của HR. */
export class AiUpdateCandidateDto extends CandidateProfileDto {}

export class AiFindOrCreateApplicationDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  candidateId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  jobId!: number;

  @IsOptional()
  @IsEnum(CandidateSource)
  source?: CandidateSource;
}

/**
 * Dữ liệu AI đã thu thập — được ghi vào hồ sơ ứng viên rồi mới chấm. Điểm do
 * backend tính; `aiSummary` chỉ lưu để HR đọc, không ảnh hưởng điểm.
 */
export class AiScreenApplicationDto {
  /** Kỹ năng đã map về đúng từ vựng `requiredSkills/preferredSkills` của vị trí. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @TrimEach()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  extractedSkills?: string[];

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(5000)
  experienceSummary?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(600)
  totalExperienceMonths?: number;

  @IsOptional()
  @Matches(DATE_ONLY, { message: 'availableFrom phải có dạng YYYY-MM-DD' })
  availableFrom?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY)
  expectedSalary?: number;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(255)
  location?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(5000)
  aiSummary?: string;
}

export class AiHandoffDto {
  @IsEnum(HandoffReason)
  reason!: HandoffReason;

  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  summary!: string;

  @IsOptional()
  @IsEnum(HandoffPriority)
  priority?: HandoffPriority;
}

export class AiDeletionRequestDto {
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class AiSaveMessageDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  candidateId!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  applicationId?: number;

  @IsEnum(ConversationChannel)
  channel!: ConversationChannel;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(255)
  externalConversationId?: string;

  /** ID tin nhắn phía kênh — chống lưu trùng khi retry. */
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(255)
  externalMessageId?: string;

  @IsEnum(MessageSenderType)
  senderType!: MessageSenderType;

  @IsEnum(MessageDirection)
  direction!: MessageDirection;

  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  content!: string;

  @IsOptional()
  @IsEnum(MessageContentType)
  contentType?: MessageContentType;

  @IsOptional()
  @IsSafeMetadata()
  metadata?: Record<string, string | number | boolean | null>;
}

export class AiInterviewSlotsQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  jobId!: number;

  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class AiProposeInterviewDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  applicationId!: number;

  /** Bắt buộc chọn slot HR đã mở — AI không tự đặt giờ. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  slotId!: number;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
