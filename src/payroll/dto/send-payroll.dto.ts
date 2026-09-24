import { Type } from 'class-transformer';
import { ArrayMinSize, ArrayNotEmpty, IsInt, Min } from 'class-validator';

export class SendPayrollDto {
  @ArrayNotEmpty()
  @ArrayMinSize(1)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids!: number[];
}
