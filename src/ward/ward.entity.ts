import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, OneToMany, Index } from 'typeorm';
import { Province } from '../province/province.entity';
import { School } from 'src/school/schools.entity';

@Index(
    ['name', 'province_id'],
    { unique: true },
)
@Entity('wards')
export class Ward {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ length: 255 })
    name!: string;

    @Column({ nullable: true })
    province_id!: number;

    @ManyToOne(() => Province, { nullable: false, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'province_id' })
    province!: Province;

    @OneToMany(() => School, (s) => s.ward)
    schools!: School[];
}