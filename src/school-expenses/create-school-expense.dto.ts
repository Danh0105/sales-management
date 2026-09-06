import {
    IsDateString,
    IsNumber,
    IsOptional,
    IsString,
} from 'class-validator';

export class CreateRealExpenseDto {
    @IsNumber()
    schoolId?: number;

    @IsNumber()
    subjectId?: number;

    @IsNumber()
    invoiceAmount?: number;

    @IsDateString()
    paymentDate?: Date;

    @IsNumber()
    totalOutsideExpense?: number;

    @IsNumber()
    paidAmount?: number;

    @IsNumber()
    remainingAmount?: number;

    @IsOptional()
    @IsString()
    payer?: string;

    @IsOptional()
    @IsString()
    note?: string;
}