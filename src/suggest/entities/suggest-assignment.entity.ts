import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';

import { Employee } from '../../employee/employee.entity';
import { Suggest } from './suggest.entity';

/** Vai trò của người được Giám đốc giao việc trên đề xuất thiết bị/sửa chữa. */
export enum AssignmentRole {
    /** Người bàn giao — giữ bước của phòng kỹ thuật (trùng `Suggest.assignedTechnicianId`). */
    HANDOVER = 'HANDOVER',
    /** Người hỗ trợ — không giữ bước nào, chỉ cùng tham gia. */
    SUPPORT = 'SUPPORT',
}

export enum AssignmentStatus {
    ASSIGNED = 'ASSIGNED',
    /** Đã từ chối kèm lý do, chờ Giám đốc chọn người thay thế. */
    DECLINED = 'DECLINED',
    /** Giám đốc đã chọn người thay thế (dòng mới trỏ về qua `replacedById`). */
    REPLACED = 'REPLACED',
}

/**
 * Một người được giao việc trên đề xuất (người bàn giao + các người hỗ trợ).
 * Không xoá dòng khi từ chối/thay thế để giữ lại ai đã từ chối và vì sao.
 */
@Entity('suggest_assignment')
@Index(['suggestId', 'status'])
@Index(['employeeId', 'status'])
export class SuggestAssignment {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    suggestId!: number;

    @ManyToOne(() => Suggest, (s) => s.assignments, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'suggestId' })
    suggest?: Suggest;

    @Column()
    employeeId!: number;

    @ManyToOne(() => Employee, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'employeeId' })
    employee?: Employee;

    @Column({ type: 'varchar', length: 20 })
    role!: AssignmentRole;

    @Column({ type: 'varchar', length: 20, default: AssignmentStatus.ASSIGNED })
    status!: AssignmentStatus;

    @Column({ type: 'text', name: 'decline_reason', nullable: true })
    declineReason?: string | null;

    @Column({ type: 'timestamptz', name: 'declined_at', nullable: true })
    declinedAt?: Date | null;

    /** Dòng giao việc mới thay cho dòng này (khi status = REPLACED). */
    @Column({ type: 'int', name: 'replaced_by_id', nullable: true })
    replacedById?: number | null;

    /** Người giao việc (Giám đốc/Sales Admin duyệt hoặc chọn người thay thế). */
    @Column({ type: 'int', name: 'assigned_by' })
    assignedBy!: number;

    @CreateDateColumn()
    createdAt!: Date;
}
