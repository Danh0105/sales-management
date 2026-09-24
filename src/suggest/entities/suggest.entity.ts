// suggest.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, JoinColumn, ManyToOne, OneToMany, OneToOne, Index } from 'typeorm';
import { SuggestStatus } from '../SuggestStatus.enum';
import { SuggestType } from '../enums/suggest-type.enum';
import { ExpenseRequestKind } from '../enums/expense-request-kind.enum';
import { EquipmentSource } from '../enums/equipment-source.enum';
import { Policy } from '../../policy/entities/policy.entity';
import { Employee } from '../../employee/employee.entity';
import { School } from '../../school/schools.entity';
import { Ward } from '../../ward/ward.entity';
import { SuggestPaymentOrder } from './suggest-payment-order.entity';
import { SuggestStockIssueOrder } from './suggest-stock-issue-order.entity';
import { SuggestStockInOrder } from './suggest-stock-in-order.entity';
import { SuggestAttachment } from './suggest-attachment.entity';
import { SuggestAssignment } from './suggest-assignment.entity';

/** Một dòng thiết bị kinh doanh mong muốn khi tạo đề xuất thiết bị. */
export interface RequestedEquipmentItem {
    name: string;
    quantity: number;
    unit?: string | null;
    /** Chọn từ thiết bị có sẵn trong kho, nếu có. */
    warehouseItemId?: number | null;
}

@Entity()
@Index(['type', 'status'])
@Index(['type', 'expectedPaymentDate'])
@Index('idx_suggest_expense_school_year_status', ['type', 'schoolId', 'schoolYear', 'status'])
@Index(['type', 'requestKind', 'status'])
export class Suggest {
    @PrimaryGeneratedColumn()
    id?: number;

    /** Phân loại luồng: SUGGESTION (cũ) | EXPENSE_REQUEST (đề xuất chi) */
    @Column({
        type: 'enum',
        enum: SuggestType,
        default: SuggestType.SUGGESTION,
    })
    type?: SuggestType;

    /**
     * Loại đề xuất chi: tiền (về kế toán lên lệnh chi) hay thiết bị (về phòng
     * kỹ thuật lên lệnh xuất kho). Chỉ có nghĩa khi `type = EXPENSE_REQUEST`.
     * Để trống trong lúc chờ duyệt vì Giám đốc là người quyết định loại.
     */
    @Column({
        type: 'enum',
        enum: ExpenseRequestKind,
        name: 'request_kind',
        nullable: true,
    })
    requestKind?: ExpenseRequestKind | null;

    @Column({ type: 'text' })
    content?: string;

    @Column({ nullable: true })
    component?: string;

    @Column({ type: 'text', nullable: true })
    description?: string;

    @Column({ type: 'date', nullable: true })
    issueDate?: Date;

    @Column({ nullable: true })
    fileUrl?: string;

    @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
    amount?: number | null;

    @CreateDateColumn()
    createdAt?: Date;

    @Column({ default: 1 })
    version?: number;

    @ManyToOne(() => Policy, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'policyId' })
    policy?: Policy;

    @Column({ nullable: true })
    policyId?: number | null;

    /**
     * Cờ đánh dấu do kinh doanh tự chọn khi tạo đề xuất chi: đề xuất này nên
     * trừ vào chính sách liên quan. Chỉ để hiển thị/thống kê, không có logic
     * tính toán trừ tiền tự động kèm theo.
     */
    @Column({ name: 'deduct_policy', type: 'boolean', default: false })
    deductPolicy?: boolean;

    /** Xã/phường gửi đề xuất; độc lập với policyId để đề xuất có thể tạo trước chính sách. */
    @ManyToOne(() => Ward, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'wardId' })
    ward?: Ward | null;

    @Column({ nullable: true })
    wardId?: number | null;

    @Column({
        type: 'enum',
        enum: SuggestStatus,
        default: SuggestStatus.PENDING,
    })
    status?: SuggestStatus;

    @Column({ nullable: true })
    reviewedBy?: number;

    @Column({ nullable: true })
    approvedBy?: number;

    @Column({ type: 'text', nullable: true })
    rejectReason?: string | null;

    /** Ghi chú chung của Giám đốc/Sales Admin khi duyệt đề xuất (không bắt buộc). */
    @Column({ type: 'text', name: 'approve_note', nullable: true })
    approveNote?: string | null;

    /**
     * Nhân viên phòng kỹ thuật (role `ky_thuat`) được Giám đốc/Sales Admin chỉ
     * định phụ trách xử lý khi duyệt đề xuất `EQUIPMENT`/`REPAIR`. Không bắt
     * buộc — nếu bỏ trống thì cả phòng kỹ thuật cùng thấy đề xuất như trước.
     */
    @Index('IDX_suggest_assigned_technician')
    @Column({ type: 'int', name: 'assigned_technician_id', nullable: true })
    assignedTechnicianId?: number | null;

    @ManyToOne(() => Employee, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'assigned_technician_id' })
    assignedTechnician?: Employee | null;

    @ManyToOne(() => Employee, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'createdBy' })
    createdByUser?: Employee;

    @CreateDateColumn()
    updatedAt?: Date;

    @Column({ nullable: true })
    createdBy?: number;

    // ============================================================
    // ===== Các trường riêng cho luồng ĐỀ XUẤT CHI (EXPENSE) =====
    // (đều nullable để không ảnh hưởng luồng SUGGESTION cũ)
    // ============================================================

    /** Mã đề xuất chi tự sinh: DX-YYYYMM-xxxx */
    @Column({ type: 'varchar', nullable: true, unique: true })
    code?: string | null;

    /** Ngày dự kiến chi — mốc cho chức năng báo động */
    @Column({ type: 'date', nullable: true })
    expectedPaymentDate?: string | null;

    /** Thông tin người thụ hưởng (tên, STK, ngân hàng...) */
    @Column({ type: 'text', nullable: true })
    beneficiaryInfo?: string | null;

    /** Thành phần tham gia (VD: "Giám đốc, kế toán, khách hàng...") */
    @Column({ type: 'text', nullable: true })
    participants?: string | null;

    /** Trường liên quan */
    @Column({ type: 'int', name: 'school_id', nullable: true })
    schoolId?: number | null;

    @ManyToOne(() => School, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'school_id' })
    school?: School | null;

    /** Năm học được chọn chính thức cho đề xuất chi (VD: 2026-2027) */
    @Column({ type: 'varchar', name: 'school_year', length: 20, nullable: true })
    schoolYear?: string | null;

    @Column({ default: false })
    isOverdue?: boolean;

    /** Đã tắt nhắc quá hạn cho riêng đề xuất này — cron vẫn chạy nhưng bỏ qua bản ghi này. */
    @Column({ name: 'overdue_alert_muted', default: false })
    overdueAlertMuted?: boolean;

    @Column({ type: 'timestamptz', nullable: true })
    approvedAt?: Date | null;

    @Column({ type: 'int', nullable: true })
    cashReleasedBy?: number | null;

    @Column({ type: 'timestamptz', nullable: true })
    cashReleasedAt?: Date | null;

    @Column({ type: 'timestamptz', nullable: true })
    cashReceivedAt?: Date | null;

    @Column({ type: 'timestamptz', nullable: true })
    spentAt?: Date | null;

    /** Lý do chưa chi (nhánh NOT_SPENT) */
    @Column({ type: 'text', nullable: true })
    notSpentReason?: string | null;

    @Column({ type: 'int', nullable: true })
    fundReturnedBy?: number | null;

    @Column({ type: 'timestamptz', nullable: true })
    fundReturnedAt?: Date | null;

    // ===== Kiểm duyệt của Sales Admin (song song, KHÔNG chặn giám đốc) =====

    /** Kết quả kiểm duyệt của Sales Admin: REVIEWED (đạt) | REJECTED (từ chối chính sách) */
    @Column({ type: 'varchar', length: 20, nullable: true })
    saleadminReviewStatus?: 'REVIEWED' | 'REJECTED' | null;

    /** Ghi chú của Sales Admin khi kiểm duyệt / từ chối chính sách */
    @Column({ type: 'text', nullable: true })
    saleadminNote?: string | null;

    @Column({ type: 'int', nullable: true })
    saleadminReviewedBy?: number | null;

    @Column({ type: 'timestamptz', nullable: true })
    saleadminReviewedAt?: Date | null;

    // ===== nhánh ĐỀ XUẤT THIẾT BỊ =====

    /**
     * Danh sách thiết bị kinh doanh mong muốn khi tạo đề xuất (mỗi dòng có thể
     * chọn `warehouseItemId` có sẵn trong kho hoặc để trống nếu là thiết bị
     * cần mua mới). Chỉ mang tính tham khảo — phòng kỹ thuật chốt danh sách
     * thật khi lập lệnh xuất kho (`SuggestStockIssueOrder.items`).
     */
    @Column({ type: 'jsonb', name: 'requested_items', nullable: true })
    requestedItems?: RequestedEquipmentItem[] | null;

    /** Kinh doanh xác nhận đã nhận thiết bị */
    @Column({ type: 'timestamptz', name: 'equipment_received_at', nullable: true })
    equipmentReceivedAt?: Date | null;

    /** Kỹ thuật xác nhận đã nhập lại kho thiết bị chưa dùng */
    @Column({ type: 'int', name: 'equipment_returned_by', nullable: true })
    equipmentReturnedBy?: number | null;

    @Column({ type: 'timestamptz', name: 'equipment_returned_at', nullable: true })
    equipmentReturnedAt?: Date | null;

    // ===== phản hồi của PHÒNG KỸ THUẬT cho đề xuất SỬA CHỮA =====

    @Column({ type: 'int', name: 'technical_responded_by', nullable: true })
    technicalRespondedBy?: number | null;

    @Column({ type: 'timestamptz', name: 'technical_responded_at', nullable: true })
    technicalRespondedAt?: Date | null;

    /** Bắt buộc khi phòng kỹ thuật từ chối nhận việc sửa chữa. */
    @Column({ type: 'text', name: 'technical_reject_reason', nullable: true })
    technicalRejectReason?: string | null;

    // ===== ĐỀ XUẤT THIẾT BỊ mua từ NHÀ CUNG CẤP =====

    /**
     * Nguồn thiết bị Giám đốc chọn khi duyệt đề xuất thiết bị: kho công ty hay
     * nhà cung cấp. Chỉ có nghĩa khi `requestKind = EQUIPMENT`; để trống = kho.
     */
    @Column({
        type: 'varchar',
        length: 20,
        name: 'equipment_source',
        nullable: true,
    })
    equipmentSource?: EquipmentSource | null;

    /** Người xử lý phiếu nhập kho — Giám đốc chỉ định khi duyệt. */
    @Index('IDX_suggest_stock_in_handler')
    @Column({ type: 'int', name: 'stock_in_handler_id', nullable: true })
    stockInHandlerId?: number | null;

    @ManyToOne(() => Employee, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'stock_in_handler_id' })
    stockInHandler?: Employee | null;

    /** Người nghiệm thu bàn giao — xác nhận hoàn thành đề xuất. */
    @Index('IDX_suggest_acceptor')
    @Column({ type: 'int', name: 'acceptor_id', nullable: true })
    acceptorId?: number | null;

    @ManyToOne(() => Employee, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'acceptor_id' })
    acceptor?: Employee | null;

    @OneToOne(() => SuggestStockInOrder, (o) => o.suggest)
    stockInOrder?: SuggestStockInOrder;

    @OneToOne(() => SuggestPaymentOrder, (po) => po.suggest)
    paymentOrder?: SuggestPaymentOrder;

    @OneToOne(() => SuggestStockIssueOrder, (so) => so.suggest)
    stockIssueOrder?: SuggestStockIssueOrder;

    @OneToMany(() => SuggestAttachment, (att) => att.suggest)
    attachments?: SuggestAttachment[];

    /** Người bàn giao + người hỗ trợ Giám đốc giao khi duyệt (kể cả người đã từ chối). */
    @OneToMany(() => SuggestAssignment, (a) => a.suggest)
    assignments?: SuggestAssignment[];
}
