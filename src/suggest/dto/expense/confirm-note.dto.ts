import { IsOptional, IsString } from 'class-validator';

/** Ghi chú kèm theo các action xác nhận (optional) */
export class ConfirmNoteDto {
    @IsOptional()
    @IsString()
    note?: string;
}
