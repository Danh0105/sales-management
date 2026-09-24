import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreatePayrollDto } from './create-payroll.dto';

/** Không cho chuyển phiếu sang nhân viên/kỳ khác; hãy xoá bản nháp và tạo lại. */
export class UpdatePayrollDto extends PartialType(
  OmitType(CreatePayrollDto, ['employeeId', 'month', 'year'] as const),
) {}
