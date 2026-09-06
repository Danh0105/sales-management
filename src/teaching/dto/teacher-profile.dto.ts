import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const normalizePhone = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/\s+/g, '') : value;
const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const toBoolean = ({ value }: { value: unknown }) => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
};

export class UpdateTeacherProfileDto {
  @ApiPropertyOptional({
    example: 'Nguyễn Văn A',
    minLength: 2,
    maxLength: 100,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    example: '+84901234567',
    description: '8–15 chữ số, có thể bắt đầu bằng dấu +',
  })
  @IsOptional()
  @Transform(normalizePhone)
  @IsString()
  @Matches(/^\+?\d{8,15}$/, { message: 'Số điện thoại không hợp lệ' })
  phone?: string;

  @ApiPropertyOptional({ example: 'teacher@example.com', maxLength: 150 })
  @IsOptional()
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Email không hợp lệ' })
  @MaxLength(150)
  email?: string;

  @ApiPropertyOptional({ type: 'string', format: 'binary' })
  @IsOptional()
  avatar?: unknown;

  @ApiPropertyOptional({ type: Boolean, example: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  removeAvatar?: boolean;
}

export class TeacherProfileResponseDto {
  @ApiProperty({ example: 123 }) id!: number;
  @ApiProperty({ example: 'Nguyễn Văn A' }) name!: string;
  @ApiProperty({ nullable: true, example: '0901234567' }) phone!: string | null;
  @ApiProperty({ nullable: true, example: 'teacher@example.com' }) email!:
    | string
    | null;
  @ApiProperty({
    nullable: true,
    example: 'https://example.com/uploads/avatars/file.webp',
  })
  avatarUrl!: string | null;
  @ApiProperty({ nullable: true, example: 150000 })
  defaultRatePerPeriod!: number | null;
  @ApiProperty({ nullable: true, example: 10.7769 }) latitude!: number | null;
  @ApiProperty({ nullable: true, example: 106.7009 }) longitude!: number | null;
  @ApiProperty({ nullable: true, enum: ['pending'] }) locationChangeStatus!:
    | 'pending'
    | null;
  @ApiProperty({
    nullable: true,
    example: { latitude: 10.78, longitude: 106.71 },
  })
  pendingLocation!: { latitude: number; longitude: number } | null;
  @ApiProperty({ example: '2026-08-11T10:00:00.000Z' }) updatedAt!: string;
}
