import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

import { WarehouseItem } from './entities/warehouse-item.entity';
import {
    WarehouseReceipt,
    WarehouseReceiptItem,
    WarehouseReceiptType,
} from './entities/warehouse-receipt.entity';
import { CreateWarehouseItemDto } from './dto/create-warehouse-item.dto';
import { UpdateWarehouseItemDto } from './dto/update-warehouse-item.dto';
import { CreateWarehouseReceiptDto } from './dto/create-warehouse-receipt.dto';
import { vnYearMonth } from '../suggest/utils/vn-date';

/** Một dòng xuất kho tối giản dùng khi export được gọi từ nhánh đề xuất thiết bị. */
export interface WarehouseExportLine {
    warehouseItemId: number;
    quantity: number;
}

/** Một dòng nhập kho của đề xuất thiết bị từ nhà cung cấp — có thể chưa có mã trong kho. */
export interface WarehousePurchaseLine {
    warehouseItemId?: number | null;
    name: string;
    unit?: string | null;
    quantity: number;
    unitPrice?: number | null;
}

@Injectable()
export class WarehouseService {
    constructor(
        @InjectRepository(WarehouseItem)
        private readonly itemRepo: Repository<WarehouseItem>,
        @InjectRepository(WarehouseReceipt)
        private readonly receiptRepo: Repository<WarehouseReceipt>,
        private readonly dataSource: DataSource,
    ) {}

    private async generateCode(
        manager: EntityManager,
        table: 'warehouse_item' | 'warehouse_receipt',
        prefixLetter: 'TB' | 'PNK' | 'PXK',
    ): Promise<string> {
        const prefix =
            table === 'warehouse_item' ? `${prefixLetter}-` : `${prefixLetter}-${vnYearMonth()}-`;

        await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
            `${table}_code_${prefix}`,
        ]);

        const row: { code: string } | undefined = (
            await manager.query(
                `SELECT code FROM ${table} WHERE code LIKE $1 ORDER BY code DESC LIMIT 1`,
                [`${prefix}%`],
            )
        )[0];

        const seq = row ? parseInt(row.code.slice(prefix.length), 10) + 1 : 1;

        return prefix + String(seq).padStart(4, '0');
    }

    async listItems(): Promise<WarehouseItem[]> {
        return this.itemRepo.find({ order: { name: 'ASC' } });
    }

    async getItem(id: number): Promise<WarehouseItem> {
        const item = await this.itemRepo.findOne({ where: { id } });
        if (!item) throw new NotFoundException('Thiết bị không tồn tại trong kho');
        return item;
    }

    async createItem(
        dto: CreateWarehouseItemDto,
        actorId: number,
    ): Promise<WarehouseItem> {
        const initialQuantity = dto.initialQuantity ?? 0;

        return this.dataSource.transaction(async (manager) => {
            const code = await this.generateCode(manager, 'warehouse_item', 'TB');

            const item = await manager.save(WarehouseItem, {
                code,
                name: dto.name,
                unit: dto.unit ?? 'cái',
                imei: dto.imei ?? null,
                quantity: initialQuantity,
                note: dto.note ?? null,
                createdBy: actorId,
            });

            if (initialQuantity > 0) {
                const receiptCode = await this.generateCode(
                    manager,
                    'warehouse_receipt',
                    'PNK',
                );
                await manager.save(WarehouseReceipt, {
                    code: receiptCode,
                    type: WarehouseReceiptType.IN,
                    items: [
                        {
                            warehouseItemId: item.id,
                            name: item.name,
                            quantity: initialQuantity,
                            unit: item.unit,
                        },
                    ],
                    note: 'Nhập kho ban đầu khi tạo thiết bị',
                    createdBy: actorId,
                });
            }

            return item;
        });
    }

    async updateItem(
        id: number,
        dto: UpdateWarehouseItemDto,
    ): Promise<WarehouseItem> {
        const item = await this.getItem(id);
        Object.assign(item, {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
            ...(dto.imei !== undefined ? { imei: dto.imei } : {}),
            ...(dto.note !== undefined ? { note: dto.note } : {}),
        });
        return this.itemRepo.save(item);
    }

    async listReceipts(): Promise<WarehouseReceipt[]> {
        return this.receiptRepo.find({ order: { createdAt: 'DESC' } });
    }

    async createReceipt(
        dto: CreateWarehouseReceiptDto,
        actorId: number,
    ): Promise<WarehouseReceipt> {
        return this.dataSource.transaction(async (manager) => {
            const lines = await this.applyStockChange(
                manager,
                dto.type,
                dto.items,
            );

            const code = await this.generateCode(
                manager,
                'warehouse_receipt',
                dto.type === WarehouseReceiptType.IN ? 'PNK' : 'PXK',
            );

            return manager.save(WarehouseReceipt, {
                code,
                type: dto.type,
                items: lines,
                note: dto.note ?? null,
                createdBy: actorId,
            });
        });
    }

    /**
     * Cộng/trừ tồn kho cho một danh sách dòng thiết bị trong cùng transaction,
     * trả về snapshot tên/đơn vị để lưu vào phiếu.
     */
    private async applyStockChange(
        manager: EntityManager,
        type: WarehouseReceiptType,
        lines: { warehouseItemId: number; quantity: number }[],
    ): Promise<WarehouseReceiptItem[]> {
        const result: WarehouseReceiptItem[] = [];

        for (const line of lines) {
            const item = await manager.findOne(WarehouseItem, {
                where: { id: line.warehouseItemId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!item) {
                throw new NotFoundException(
                    `Thiết bị #${line.warehouseItemId} không tồn tại trong kho`,
                );
            }

            if (type === WarehouseReceiptType.IN) {
                item.quantity += line.quantity;
            } else {
                if (item.quantity < line.quantity) {
                    throw new BadRequestException(
                        `Không đủ tồn kho cho "${item.name}" (còn ${item.quantity}, cần ${line.quantity})`,
                    );
                }
                item.quantity -= line.quantity;
            }

            await manager.save(item);

            result.push({
                warehouseItemId: item.id,
                name: item.name,
                quantity: line.quantity,
                unit: item.unit,
            });
        }

        return result;
    }

    /**
     * Xuất kho cho các dòng thiết bị được chọn từ kho có sẵn trong một lệnh xuất
     * kho của đề xuất thiết bị. Được gọi trong transaction của
     * `SuggestService.createExpenseStockIssueOrder` nên nhận sẵn `manager`.
     */
    async exportForSuggestWithManager(
        manager: EntityManager,
        lines: WarehouseExportLine[],
        actorId: number,
        relatedSuggestId: number,
    ): Promise<WarehouseReceipt | null> {
        if (lines.length === 0) return null;

        const items = await this.applyStockChange(
            manager,
            WarehouseReceiptType.OUT,
            lines,
        );

        const code = await this.generateCode(manager, 'warehouse_receipt', 'PXK');

        return manager.save(WarehouseReceipt, {
            code,
            type: WarehouseReceiptType.OUT,
            items,
            note: `Xuất kho theo đề xuất thiết bị #${relatedSuggestId}`,
            relatedSuggestId,
            createdBy: actorId,
        });
    }

    /**
     * Nhập kho thiết bị mua từ nhà cung cấp cho đề xuất thiết bị. Dòng chưa
     * có `warehouseItemId` được tạo mới thành một loại thiết bị trong kho (tồn
     * 0) rồi mới cộng tồn qua phiếu — để tồn kho vẫn chỉ đổi qua phiếu.
     * Chạy trong transaction của `SuggestService.createStockInReceipt`.
     */
    async importPurchaseForSuggestWithManager(
        manager: EntityManager,
        lines: WarehousePurchaseLine[],
        actorId: number,
        relatedSuggestId: number,
        note: string,
    ): Promise<{ receipt: WarehouseReceipt; itemIds: number[] }> {
        const resolved: WarehouseExportLine[] = [];

        for (const line of lines) {
            if (line.warehouseItemId != null) {
                resolved.push({
                    warehouseItemId: line.warehouseItemId,
                    quantity: line.quantity,
                });
                continue;
            }

            const code = await this.generateCode(manager, 'warehouse_item', 'TB');
            const created = await manager.save(WarehouseItem, {
                code,
                name: line.name,
                unit: line.unit || 'cái',
                imei: null,
                quantity: 0,
                note: `Tạo khi nhập kho đề xuất thiết bị #${relatedSuggestId}`,
                createdBy: actorId,
            });
            resolved.push({ warehouseItemId: created.id, quantity: line.quantity });
        }

        const items = await this.applyStockChange(
            manager,
            WarehouseReceiptType.IN,
            resolved,
        );

        const code = await this.generateCode(manager, 'warehouse_receipt', 'PNK');

        const receipt = await manager.save(WarehouseReceipt, {
            code,
            type: WarehouseReceiptType.IN,
            items: items.map((it, i) => ({
                ...it,
                unitPrice: lines[i].unitPrice ?? null,
            })),
            note,
            relatedSuggestId,
            createdBy: actorId,
        });

        return { receipt, itemIds: resolved.map((l) => l.warehouseItemId) };
    }

    /**
     * Nhập lại kho khi kinh doanh trả lại thiết bị chưa dùng của một đề xuất
     * thiết bị (đối xứng với `exportForSuggestWithManager`).
     */
    async importForSuggestWithManager(
        manager: EntityManager,
        lines: WarehouseExportLine[],
        actorId: number,
        relatedSuggestId: number,
    ): Promise<WarehouseReceipt | null> {
        if (lines.length === 0) return null;

        const items = await this.applyStockChange(
            manager,
            WarehouseReceiptType.IN,
            lines,
        );

        const code = await this.generateCode(manager, 'warehouse_receipt', 'PNK');

        return manager.save(WarehouseReceipt, {
            code,
            type: WarehouseReceiptType.IN,
            items,
            note: `Nhập lại kho do trả thiết bị của đề xuất #${relatedSuggestId}`,
            relatedSuggestId,
            createdBy: actorId,
        });
    }
}
