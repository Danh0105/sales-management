import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
    Index,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { School } from '../../school/schools.entity';
import { Ward } from '../../ward/ward.entity';
import { numericTransformer } from '../../utils/numeric-transformer';

/**
 * Điểm trường (chi nhánh) của một trường học.
 *
 * Mỗi trường có thể có nhiều điểm trường hoạt động độc lập, mỗi điểm có:
 * - Toạ độ + bán kính check-in riêng (để chấm công GPS tại đúng địa điểm vật lý)
 * - Lớp học, môn học, lịch dạy riêng
 *
 * Trường chưa khai điểm trường nào sẽ tiếp tục dùng toạ độ/bán kính trên chính
 * School entity và hoạt động như hôm nay (tương thích ngược 100%).
 * Trường khai điểm trường thì dữ liệu quan tâm sẽ gắn xuống điểm trường.
 */
@Entity('school_locations')
@Index('IDX_school_locations_school_id', ['schoolId'])
@Index('UQ_school_locations_school_name', ['schoolId', 'name'], { unique: true })
export class SchoolLocation {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ name: 'school_id' })
    schoolId!: number;

    @ManyToOne(() => School, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'school_id' })
    school!: School;

    /**
     * Tên điểm trường (VD: "Cơ sở chính", "Chi nhánh Q.1", "Học xa"…).
     * Unique trong một trường.
     */
    @Column({ type: 'varchar', length: 150 })
    name!: string;

    /** Địa chỉ cụ thể của điểm trường. */
    @Column({ type: 'varchar', length: 500, nullable: true })
    address?: string | null;

    /** Vĩ độ (latitude) để xác định vị trí chính xác (chấm công GPS). */
    @Column({
        type: 'decimal',
        precision: 10,
        scale: 7,
        nullable: true,
        transformer: numericTransformer,
    })
    latitude?: number | null;

    /** Kinh độ (longitude) để xác định vị trí chính xác (chấm công GPS). */
    @Column({
        type: 'decimal',
        precision: 10,
        scale: 7,
        nullable: true,
        transformer: numericTransformer,
    })
    longitude?: number | null;

    /**
     * Bán kính cho phép kiểm tra GPS (mét). Giáo viên check-in/out ngoài bán kính
     * này sẽ được cảnh báo "ngoài phạm vi điểm trường".
     */
    @Column({ name: 'checkin_radius', type: 'int', nullable: true })
    checkinRadius?: number | null;

    /**
     * URL Google Maps để lưu trữ/hiển thị vị trí điểm trường
     * (VD: "https://maps.google.com/?q=10.7833,106.6833").
     */
    @Column({ name: 'google_maps_url', type: 'varchar', length: 500, nullable: true })
    googleMapsUrl?: string | null;

    /**
     * Phường/xã mà điểm trường này nằm trong.
     * Một phần thông tin địa chỉ hành chính, cùng mục đích như School.ward.
     */
    @ManyToOne(() => Ward, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'ward_id' })
    ward?: Ward | null;

    /** Trạng thái của điểm trường (giống School.status). */
    @Column({ type: 'int', default: 1 })
    status!: number;

    @CreateDateColumn({ name: 'created_at' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt!: Date;
}
