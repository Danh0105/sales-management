import { IsNotEmpty, IsString } from 'class-validator';

export class RejectExpenseDto {
    @IsString()
    @IsNotEmpty({ message: 'Phải có lý do từ chối' })
    reason!: string;
}
