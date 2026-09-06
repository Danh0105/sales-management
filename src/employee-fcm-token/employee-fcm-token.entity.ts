import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity()
export class EmployeeFcmToken {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    employeeId!: number;

    @Column()
    token!: string;

    @Column({
        nullable: true,
    })
    platform!: string;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}