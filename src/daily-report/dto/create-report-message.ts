import { IsEnum, IsNotEmpty, IsNumber, IsString } from 'class-validator';
import { ReportMessageSenderRole } from '../enums/report-message-sender-role.enum';

export class CreateReportMessageDto {
    @IsNumber()
    reportId!: number;

    @IsNumber()
    senderId!: number;

    @IsString()
    @IsNotEmpty()
    message!: string;

    @IsEnum(ReportMessageSenderRole)
    senderRole!: ReportMessageSenderRole;
}