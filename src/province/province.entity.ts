import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
@Index(
    ['name'],
    { unique: true },
)
@Entity('provinces')
export class Province {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ length: 255 })
    name!: string;
}