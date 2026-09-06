import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Settings cho chức năng báo động đề xuất chi (key-value).
 * Các key hiện dùng:
 * - 'remind_before_days' (mặc định '1')
 * - 'expense_reminders_enabled' (mặc định 'true')
 */
@Entity('suggest_reminder_setting')
export class SuggestReminderSetting {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ unique: true })
    key!: string;

    @Column()
    value!: string;

    @UpdateDateColumn()
    updatedAt!: Date;
}

export const REMIND_BEFORE_DAYS_KEY = 'remind_before_days';
export const DEFAULT_REMIND_BEFORE_DAYS = 1;
export const EXPENSE_REMINDERS_ENABLED_KEY = 'expense_reminders_enabled';
export const DEFAULT_EXPENSE_REMINDERS_ENABLED = true;
