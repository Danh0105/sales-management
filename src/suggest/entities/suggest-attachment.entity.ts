import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    ManyToOne,
    JoinColumn,
    Index,
} from 'typeorm';

import { Employee } from '../../employee/employee.entity';
import { Suggest } from './suggest.entity';

/** File đính kèm cho đề xuất chi (chứng từ, hóa đơn...) */
@Entity('suggest_attachment')
@Index(['suggestId'])
export class SuggestAttachment {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    suggestId!: number;

    @ManyToOne(() => Suggest, (s) => s.attachments, {
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'suggestId' })
    suggest?: Suggest;

    @Column()
    fileUrl!: string;

    @Column()
    fileName!: string;

    @Column()
    uploadedBy!: number;

    @ManyToOne(() => Employee)
    @JoinColumn({ name: 'uploadedBy' })
    uploader?: Employee;

    @CreateDateColumn()
    createdAt!: Date;
}
