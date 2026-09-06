import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { Training } from "./trainings.entity";
import { Employee } from "../employee/employee.entity";

@Entity("training_progress")
export class TrainingProgress {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    trainingId!: number;

    @Column({ type: "float", default: 0, })
    watchedSeconds!: number;

    @Column({ default: 0 })
    percent!: number;

    @Column({ default: false })
    completed!: boolean;

    @Column({
        type: "timestamp",
        nullable: true,
    })
    completedAt!: Date | null;

    @Column()
    employeeId!: number;

    @ManyToOne(() => Employee, (employee) => employee.trainingProgresses, { onDelete: "CASCADE", },)
    @JoinColumn({ name: "employeeId", })
    employee!: Employee;

    @Column({ type: "float", default: 0, })
    lastVideoSecond!: number;

    @ManyToOne(() => Training)
    @JoinColumn({ name: "trainingId" })
    training!: Training;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}