import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { ConversationControlMode } from '../recruitment.enums';
import { PaginationQueryDto, Trim } from './common.dto';

/** Màn "Hội thoại Zalo" của HR. */
export class ConversationListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @IsEnum(ConversationControlMode)
  mode?: ConversationControlMode;

  /** Chỉ hội thoại đang có tin AI chờ duyệt. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  pendingOnly?: boolean;
}

export class ConversationMessagesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

/** Nhóm hiển thị của hàng đợi duyệt — ánh xạ cố định sang điều kiện SQL ở service. */
export const APPROVAL_VIEWS = [
  'pending',
  'approved',
  'sent',
  'rejected',
  'failed',
  'all',
] as const;
export type ApprovalView = (typeof APPROVAL_VIEWS)[number];

export class ApprovalListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(APPROVAL_VIEWS)
  view?: ApprovalView;
}
