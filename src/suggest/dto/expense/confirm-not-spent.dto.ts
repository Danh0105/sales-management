import { IsNotEmpty, IsString } from 'class-validator';

export class ConfirmNotSpentDto {
    @IsString()
    @IsNotEmpty({ message: 'Phải có lý do chưa chi' })
    reason!: string;
}
