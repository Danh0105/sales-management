import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value;

export class ChatMessageDto {
    @Transform(trim)
    @IsString()
    @IsNotEmpty({ message: 'Nội dung tin nhắn không được để trống' })
    @MaxLength(2000)
    message!: string;
}

/**
 * Body của `POST /timetable-import`. `message` chỉ bắt buộc khi không gửi kèm
 * ảnh — Nhân sự có thể xếp lịch bằng cách mô tả thẳng cho AI, không cần chụp
 * ảnh thời khoá biểu nào cả.
 */
export class CreateTimetableDraftDto {
    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(2000)
    message?: string;
}
