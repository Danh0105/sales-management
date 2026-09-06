import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ResolveZaloLocationDto {
  @ApiProperty({
    description: 'Token một lần từ zmp-sdk getLocation()',
    maxLength: 4096,
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  locationToken!: string;

  @ApiProperty({
    description: 'Access token từ zmp-sdk getAccessToken()',
    maxLength: 4096,
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  zaloAccessToken!: string;
}
