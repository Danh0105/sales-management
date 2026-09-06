

import {
    Entity,
    PrimaryGeneratedColumn,
    ManyToOne,
    JoinColumn,
    Column,
} from 'typeorm';
import { Employee } from '../../employee/employee.entity';
import { Province } from '../../province/province.entity';
import { Ward } from '../../ward/ward.entity';

@Entity('employee_region')
export class EmployeeRegion {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ name: 'employee_id' })
    employeeId!: number;

    @Column({ name: 'province_id', nullable: true })
    provinceId!: number;

    @Column({ name: 'ward_id', nullable: true })
    wardId!: number;

    @ManyToOne(() => Employee, (e) => e.employeeRegions, {
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'employee_id' })
    employee!: Employee;

    @ManyToOne(() => Province, {
        nullable: true,
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'province_id' })
    province!: Province;

    @ManyToOne(() => Ward, {
        nullable: true,
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'ward_id' })
    ward!: Ward;
}