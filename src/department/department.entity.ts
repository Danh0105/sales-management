// department.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { Employee } from '../employee/employee.entity';
import { Region } from '../region/region.entity';

@Entity('department')
export class Department {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ unique: true })
    name!: string;

    @OneToMany(() => Employee, (employee) => employee.department)
    employees!: Employee[];

    @Column({ nullable: true })
    icon?: string;

    @OneToMany(() => Region, (region) => region.department)
    regions!: Region[];
}