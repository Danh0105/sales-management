import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    UpdateDateColumn,
} from 'typeorm';

@Entity()
export class Display {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({
        unique: true,
    })
    tabletCode!: string;

    @Column()
    fullName!: string;

    @Column()
    position!: string;

    @UpdateDateColumn()
    updatedAt!: Date;
}