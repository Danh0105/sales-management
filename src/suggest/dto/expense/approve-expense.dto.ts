import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

import { ExpenseRequestKind } from '../../enums/expense-request-kind.enum';
import { EquipmentSource } from '../../enums/equipment-source.enum';
import { StockInItemDto } from './create-stock-in-receipt.dto';

/**
 * Giám đốc/Sales Admin có thể chốt lại số tiền, loại đề xuất (tiền/thiết bị/
 * sửa chữa) và chỉ định nhân viên phòng kỹ thuật phụ trách ngay khi duyệt.
 * Loại đề xuất là bắt buộc với đề xuất chi Năm vì nhân viên không tự phân
 * loại lúc tạo. Đề xuất chi tháng đã cố định là CASH từ bước Kế toán công nợ,
 * nên Giám đốc chỉ cần xác nhận duyệt.
 */
export class ApproveExpenseDto {
  @IsOptional()
  @Type(() => Number)
  @Min(0, { message: 'Số tiền không được âm' })
  amount?: number;

  @IsOptional()
  @IsEnum(ExpenseRequestKind)
  requestKind?: ExpenseRequestKind;

  /**
   * Người bàn giao (nhân viên phòng kỹ thuật). Chỉ có ý nghĩa khi requestKind
   * (sau khi chốt) là EQUIPMENT lấy từ kho hoặc REPAIR.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  assignedTechnicianId?: number;

  /** Người hỗ trợ người bàn giao — chỉ dùng khi đã chọn người bàn giao. */
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  supporterIds?: number[];

  /** Ghi chú chung của Giám đốc/Sales Admin khi duyệt (không bắt buộc). */
  @IsOptional()
  @IsString()
  note?: string;

  /**
   * Chi tháng nhiều trường: các dòng (trường · môn · kỳ) Giám đốc duyệt. Bỏ
   * trống = duyệt tất cả. Dòng bỏ ra không tính vào lệnh chi; khi bỏ dòng phải
   * có ghi chú lý do.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Phải duyệt ít nhất một trường' })
  @Type(() => Number)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  approvedItemIds?: number[];

  /**
   * Nguồn thiết bị khi requestKind = EQUIPMENT: có sẵn trong kho (mặc định)
   * hay mua từ nhà cung cấp.
   */
  @IsOptional()
  @IsEnum(EquipmentSource)
  equipmentSource?: EquipmentSource;

  // ===== chỉ dùng khi equipmentSource = SUPPLIER =====

  /** Phiếu nhập kho dự kiến Giám đốc lập — tối thiểu 1 dòng. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StockInItemDto)
  stockInItems?: StockInItemDto[];

  /** Ghi chú của Giám đốc cho người xử lý phiếu nhập. */
  @IsOptional()
  @IsString()
  stockInNote?: string;

  /** Nhân viên xử lý phiếu nhập kho (lập phiếu nhập kho thật). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  stockInHandlerId?: number;

  /** Người nghiệm thu bàn giao (xác nhận hoàn thành đề xuất). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  acceptorId?: number;
}
