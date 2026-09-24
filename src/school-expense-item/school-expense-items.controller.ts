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
import { SchoolExpenseItemsService } from './school-expense-items.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { AuthUser } from '../type/auth-user.type';

type RequestWithUser = Request & { user: AuthUser };

const WRITE_ROLES = [
  'accountant',
  'ketoan_congno',
  'ketoan_truong',
  'troly_gd',
  'director',
];
// Sales admin chỉ được xem (đọc) — chỉnh sửa duy nhất bảng "Chi Ngoài" qua
// ManagementExpenseItemsController.
const SALESADMIN_ROLES = ['saleadmin', 'salesadmin', 'salesadmin_la'];

@Controller('school-expense-items')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...WRITE_ROLES)
export class SchoolExpenseItemsController {
  constructor(
    private readonly schoolExpenseItemsService: SchoolExpenseItemsService,
  ) {}

  @Post()
  create(@Body() body: any, @Req() req: RequestWithUser) {
    return this.schoolExpenseItemsService.create(body, req.user);
  }

  @Get()
  @Roles(...WRITE_ROLES, ...SALESADMIN_ROLES)
  findAll(@Query() query: any) {
    return this.schoolExpenseItemsService.findAll(query);
  }

  @Get(':id')
  @Roles(...WRITE_ROLES, ...SALESADMIN_ROLES)
  findOne(@Param('id') id: string) {
    return this.schoolExpenseItemsService.findOne(Number(id));
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: RequestWithUser,
  ) {
    return this.schoolExpenseItemsService.update(
      Number(id),
      body,
      req.user,
    );
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.schoolExpenseItemsService.remove(
      Number(id),
      req.user,
    );
  }
}
