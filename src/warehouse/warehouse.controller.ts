import {
    Body,
    Controller,
    Get,
    Param,
    ParseIntPipe,
    Patch,
    Post,
    Req,
    UnauthorizedException,
    UploadedFile,
    UseGuards,
    UseInterceptors,
    UsePipes,
    ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { ExpenseRole } from '../suggest/constants/expense-roles';

import { WarehouseService } from './warehouse.service';
import { CreateWarehouseItemDto } from './dto/create-warehouse-item.dto';
import { UpdateWarehouseItemDto } from './dto/update-warehouse-item.dto';
import { CreateWarehouseReceiptDto } from './dto/create-warehouse-receipt.dto';
import { MAX_WAREHOUSE_IMAGE_BYTES } from './warehouse-image-storage.service';

/**
 * Quản lý kho thiết bị (1 kho duy nhất). Phòng kỹ thuật (`ky_thuat`) quản lý
 * tồn kho + phiếu nhập/xuất; kinh doanh (`sales`) chỉ được xem danh sách tồn
 * để chọn thiết bị có sẵn khi tạo đề xuất thiết bị. Giám đốc được xem tồn kho
 * và phiếu nhập/xuất (không tạo/sửa) để theo dõi.
 */
@Controller('warehouse')
@UseGuards(JwtAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class WarehouseController {
    constructor(private readonly service: WarehouseService) {}

    @Get('items')
    @Roles(ExpenseRole.TECHNICAL, ExpenseRole.SALES, ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN)
    listItems() {
        return this.service.listItems();
    }

    @Get('items/:id')
    @Roles(ExpenseRole.TECHNICAL, ExpenseRole.SALES, ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN)
    getItem(@Param('id', ParseIntPipe) id: number) {
        return this.service.getItem(id);
    }

    @Post('items')
    @Roles(ExpenseRole.TECHNICAL)
    createItem(@Body() dto: CreateWarehouseItemDto, @Req() req: any) {
        if (!req.user) throw new UnauthorizedException('Chưa đăng nhập');
        return this.service.createItem(dto, req.user.id);
    }

    @Patch('items/:id')
    @Roles(ExpenseRole.TECHNICAL)
    updateItem(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateWarehouseItemDto,
    ) {
        return this.service.updateItem(id, dto);
    }

    @Post('items/:id/image')
    @Roles(ExpenseRole.TECHNICAL)
    @UseInterceptors(
        FileInterceptor('image', {
            limits: { fileSize: MAX_WAREHOUSE_IMAGE_BYTES, files: 1 },
        }),
    )
    uploadItemImage(
        @Param('id', ParseIntPipe) id: number,
        @UploadedFile() image?: Express.Multer.File,
    ) {
        return this.service.updateItemImage(id, image);
    }

    @Get('receipts')
    @Roles(ExpenseRole.TECHNICAL, ExpenseRole.DIRECTOR)
    listReceipts() {
        return this.service.listReceipts();
    }

    @Post('receipts')
    @Roles(ExpenseRole.TECHNICAL)
    createReceipt(@Body() dto: CreateWarehouseReceiptDto, @Req() req: any) {
        if (!req.user) throw new UnauthorizedException('Chưa đăng nhập');
        return this.service.createReceipt(dto, req.user.id);
    }
}
