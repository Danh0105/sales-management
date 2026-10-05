import { Transform, Type } from 'class-transformer';
import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class RevokeHrRoleAssignmentDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(5, { message: 'Lý do thu hồi tối thiểu 5 ký tự' })
  @MaxLength(2000)
  reason: string;

  /** `version` client đang thấy — lệch với DB (người khác vừa sửa) → 409. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;
}
