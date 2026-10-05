import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WarehouseItem } from './entities/warehouse-item.entity';
import { WarehouseReceipt } from './entities/warehouse-receipt.entity';
import { WarehouseService } from './warehouse.service';
import { WarehouseController } from './warehouse.controller';
import { WarehouseImageStorageService } from './warehouse-image-storage.service';

@Module({
    imports: [TypeOrmModule.forFeature([WarehouseItem, WarehouseReceipt])],
    providers: [WarehouseService, WarehouseImageStorageService],
    controllers: [WarehouseController],
    exports: [WarehouseService],
})
export class WarehouseModule {}
