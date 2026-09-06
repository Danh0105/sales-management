import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '../../utils/numeric-transformer';

/**
 * Bậc phụ cấp xăng theo khoảng cách — chỉ áp dụng cho giáo viên công ty
 * (`giaovien_congty`). Giáo viên công ty không nhận tiền theo tiết; thay vào
 * đó mỗi lần đến trường (1 block tiết liên tiếp cùng trường) được tính một
 * khoản phụ cấp cố định theo khoảng cách từ vị trí giáo viên tới trường,
 * tra theo bậc thang này.
 *
 * `maxDistanceKm = null` nghĩa là bậc cuối, không giới hạn trên.
 */
@Entity('fuel_allowance_tiers')
export class FuelAllowanceTier {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({
        name: 'min_distance_km',
        type: 'decimal',
        precision: 6,
        scale: 2,
        transformer: numericTransformer,
    })
    minDistanceKm!: number;

    /** null = không giới hạn trên (bậc xa nhất). */
    @Column({
        name: 'max_distance_km',
        type: 'decimal',
        precision: 6,
        scale: 2,
        nullable: true,
        transformer: numericTransformer,
    })
    maxDistanceKm?: number | null;

    @Column({
        type: 'decimal',
        precision: 15,
        scale: 2,
        transformer: numericTransformer,
    })
    amount!: number;

    @CreateDateColumn({ name: 'created_at' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt!: Date;
}
