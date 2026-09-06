// region.entity.ts

import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    OneToMany,
    JoinColumn,
} from 'typeorm';
import { Department } from '../department/department.entity';

@Entity('region')
export class Region {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    name!: string;

    @ManyToOne(() => Region, (region) => region.children, {
        nullable: true,
        onDelete: 'SET NULL',
    })
    parent!: Region | null;

    @OneToMany(() => Region, (region) => region.parent)
    children!: Region[];


    @ManyToOne(() => Department, (department) => department.regions)
    @JoinColumn({ name: 'department_id' })
    department!: Department;
    s
}