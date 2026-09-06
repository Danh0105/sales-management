import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
    CreateDateColumn,
} from 'typeorm';

import { Employee } from './employee.entity';

@Entity('employee_face')
export class EmployeeFace {

    @PrimaryGeneratedColumn()
    id!: number;

    @Column({
        name: 'employee_id',
    })
    employeeId!: number;

    // 🔥 FACE EMBEDDING
    @Column({
        type: 'json',
    })
    descriptor!: number[];

    // 🔥 VECTOR TRUNG TÂM
    @Column({
        type: 'json',
        nullable: true,
    })
    centroid!: number[];

    // 🔥 QUALITY SCORE
    @Column({
        type: 'float',
        default: 1,
    })
    qualityScore!: number;

    // 🔥 ACTIVE STATUS
    @Column({
        default: true,
    })
    isActive!: boolean;

    @CreateDateColumn({
        name: 'created_at',
    })
    createdAt!: Date;

    @ManyToOne(
        () => Employee,
        (employee) => employee.faces,
        {
            onDelete: 'CASCADE',
        },
    )
    @JoinColumn({
        name: 'employee_id',
    })
    employee!: Employee;
}