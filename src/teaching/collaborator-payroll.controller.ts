import {
  Controller,
  Get,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { CASHFLOW_TEACHER_PAY_ROLES } from '../school-expenses/cashflow-roles';
import { CollaboratorPayrollService } from './collaborator-payroll.service';
import { QueryCollaboratorPayrollDto } from './dto/collaborator-payroll.dto';

/** Lương giáo viên cộng tác viên cho màn Quản lý thu chi (chỉ đọc). */
@Controller('collaborator-payroll')
@UseGuards(JwtAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class CollaboratorPayrollController {
  constructor(private readonly service: CollaboratorPayrollService) {}

  /** Tổng hợp theo trường → môn → giáo viên trong khoảng ngày. */
  @Roles(...CASHFLOW_TEACHER_PAY_ROLES)
  @Get()
  summary(@Query() query: QueryCollaboratorPayrollDto) {
    return this.service.summary(query);
  }
}
