import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('teaching_schedule_notification_logs')
@Index('IDX_teaching_notify_signature_created', ['signature', 'createdAt'])
export class TeachingScheduleNotificationLog {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ name: 'sender_id', type: 'int' })
    senderId!: number;

    @Column({ name: 'from_date', type: 'date' })
    fromDate!: string;

    @Column({ name: 'to_date', type: 'date' })
    toDate!: string;

    @Column({ type: 'varchar', length: 255 })
    signature!: string;

    @Column({ type: 'jsonb' })
    filters!: Record<string, number | undefined>;

    @Column({ name: 'notified_count', type: 'int', default: 0 })
    notifiedCount!: number;

    @Column({ name: 'session_count', type: 'int', default: 0 })
    sessionCount!: number;

    @Column({ name: 'skipped_without_account', type: 'int', default: 0 })
    skippedWithoutAccount!: number;

    @Column({ name: 'email_sent_count', type: 'int', default: 0 })
    emailSentCount!: number;

    @CreateDateColumn({ name: 'created_at' })
    createdAt!: Date;
}
