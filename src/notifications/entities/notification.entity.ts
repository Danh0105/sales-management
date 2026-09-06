import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    ManyToOne,
    JoinColumn,
    Index,
} from 'typeorm';

import { NotificationType } from '../enums/notification-type.enum';
import { Employee } from '../../employee/employee.entity';



@Entity()
@Index(['receiverId', 'isRead'])
@Index(['type', 'entityId'])
export class Notification {
    @PrimaryGeneratedColumn()
    id!: number;

    // 👤 receiver
    @Column()
    receiverId!: number;

    @ManyToOne(() => Employee, (emp) => emp.notifications, {
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'receiverId' })
    receiver!: Employee;

    // 👤 sender (optional)
    @Column({ nullable: true })
    senderId?: number;

    @ManyToOne(() => Employee, {
        nullable: true,
        onDelete: 'SET NULL',
    })
    @JoinColumn({ name: 'senderId' })
    sender?: Employee;

    // 🔥 loại notification
    @Column({
        type: 'enum',
        enum: NotificationType,
    })
    type!: NotificationType;

    // 🔥 id của object liên quan (policy, suggest, ...)
    @Column({ nullable: true })
    entityId?: number;

    // 🔥 metadata mở rộng
    @Column({ type: 'json', nullable: true })
    meta?: Record<string, any>;

    // 📝 nội dung
    @Column({ type: 'text', nullable: true })
    message?: string;

    @Column({ default: false })
    isRead!: boolean;

    @CreateDateColumn()
    createdAt!: Date;
}