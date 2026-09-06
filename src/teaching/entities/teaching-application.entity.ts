import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '../../utils/numeric-transformer';
import { TeachingApplicationStatus } from '../teaching.enum';
import { Teacher } from './teacher.entity';
import { TeachingSession } from './teaching-session.entity';

@Entity('teaching_session_applications')
@Index('UQ_teaching_applications_session_teacher', ['sessionId', 'teacherId'], { unique: true })
export class TeachingApplication {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ name: 'session_id', type: 'int' })
    sessionId!: number;

    @ManyToOne(() => TeachingSession, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'session_id' })
    session!: TeachingSession;

    @Column({ name: 'teacher_id', type: 'int' })
    teacherId!: number;

    @ManyToOne(() => Teacher, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'teacher_id' })
    teacher!: Teacher;

    @Column({ type: 'enum', enum: TeachingApplicationStatus, default: TeachingApplicationStatus.PENDING })
    status!: TeachingApplicationStatus;

    @Column({ type: 'decimal', precision: 10, scale: 7, transformer: numericTransformer })
    latitude!: number;

    @Column({ type: 'decimal', precision: 10, scale: 7, transformer: numericTransformer })
    longitude!: number;

    @Column({ type: 'int', nullable: true })
    accuracy?: number | null;

    @Column({ type: 'int', nullable: true })
    distance?: number | null;

    @Column({ type: 'text', nullable: true })
    note?: string | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt!: Date;
}
