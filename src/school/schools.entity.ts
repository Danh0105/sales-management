import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
    OneToMany,
    Index,
} from 'typeorm';
import { Employee } from '../employee/employee.entity';
import { Subject } from '../subject/subject.entity';
import { Ward } from '../ward/ward.entity';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { numericTransformer } from '../utils/numeric-transformer';


@Entity('schools')
export class School {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    name!: string;

    @Column({ nullable: true })
    address!: string;

    @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true, transformer: numericTransformer })
    latitude!: number | null;

    @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true, transformer: numericTransformer })
    longitude!: number | null;

    @Column({ name: 'checkin_radius', type: 'int', nullable: true })
    checkinRadius!: number | null;

    @Column({ name: 'google_maps_url', type: 'varchar', length: 500, nullable: true })
    googleMapsUrl!: string | null;

    @Column({ nullable: true })
    representative!: string;

    @Column({ type: 'int', nullable: true })
    scale!: number;

    @Column({ name: 'tax_code', nullable: true })
    taxCode!: string;

    @Column({ nullable: true })
    phone!: string;

    @ManyToOne(() => Employee, (e) => e.schools, { nullable: true, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'employee_id' })
    @Index('IDX_schools_employee_id')
    employee?: Employee;

    @OneToMany(() => Subject, (sub) => sub.school, { cascade: true })
    subjects!: Subject[];

    @Column({ nullable: true, default: 0 })
    status!: number;

    @Column({ name: 'class_count', type: 'int', nullable: true, default: 0 })
    classCount!: number;

    @ManyToOne(() => Ward, (w) => w.schools, {
        nullable: true,
        onDelete: 'SET NULL',
    })
    @JoinColumn({ name: 'ward_id' })
    ward!: Ward;

    @OneToMany(
        () => SchoolExpense,
        (item) => item.school,
    )
    schoolExpenses!: SchoolExpense[];
}
