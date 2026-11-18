import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ManagementExpenseItemsService } from './management-expense-items.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { AuthUser } from '../type/auth-user.type';
import {
  CASHFLOW_READ_ROLES,
  CASHFLOW_WRITE_ROLES,
} from '../school-expenses/cashflow-roles';

type RequestWithUser = Request & { user: AuthUser };

@Controller('management-expense-items')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...CASHFLOW_WRITE_ROLES)
export class ManagementExpenseItemsController {
  constructor(
    private readonly managementExpenseItemsService: ManagementExpenseItemsService,
  ) {}

  @Post()
  create(@Body() body: any, @Req() req: RequestWithUser) {
    return this.managementExpenseItemsService.create(
      body,
      req.user,
    );
  }

  @Get()
  @Roles(...CASHFLOW_READ_ROLES)
  findAll(@Query() query: any) {
    return this.managementExpenseItemsService.findAll(query);
  }

  @Get(':id')
  @Roles(...CASHFLOW_READ_ROLES)
  findOne(@Param('id') id: string) {
    return this.managementExpenseItemsService.findOne(Number(id));
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: RequestWithUser,
  ) {
    return this.managementExpenseItemsService.update(
      Number(id),
      body,
      req.user,
    );
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.managementExpenseItemsService.remove(
      Number(id),
      req.user,
    );
  }
}
