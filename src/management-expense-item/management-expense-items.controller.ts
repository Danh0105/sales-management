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

type RequestWithUser = Request & { user: AuthUser };

/** Sales admin chỉnh sửa duy nhất bảng "Chi Ngoài" này (xem RealExpensesController). */
const SALESADMIN_ROLES = ['saleadmin', 'salesadmin', 'salesadmin_la'];

@Controller('management-expense-items')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(
  'accountant',
  'ketoan_congno',
  'ketoan_truong',
  'troly_gd',
  'director',
  ...SALESADMIN_ROLES,
)
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
  findAll(@Query() query: any) {
    return this.managementExpenseItemsService.findAll(query);
  }

  @Get(':id')
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
