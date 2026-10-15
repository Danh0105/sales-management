import {
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ApproveOutboxDto {
  @IsUUID()
  requestId!: string;
}

export class EditAndApproveOutboxDto extends ApproveOutboxDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text!: string;
}

export class RejectOutboxDto extends ApproveOutboxDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
