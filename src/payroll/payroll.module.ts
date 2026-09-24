import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Employee } from '../employee/employee.entity';
import { Teacher } from '../teaching/entities/teacher.entity';
import { TeachingSession } from '../teaching/entities/teaching-session.entity';
import { Payroll } from './entities/payroll.entity';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Payroll, Employee, Teacher, TeachingSession]),
  ],
  controllers: [PayrollController],
  providers: [PayrollService],
  exports: [PayrollService],
})
export class PayrollModule {}
