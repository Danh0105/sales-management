import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    Index,
    OneToMany,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';

import { Subject } from '../subject/subject.entity';

/**
 * Danh mục môn học dùng chung (sales admin tạo).
 *
 * Đây KHÔNG phải môn học của một trường — môn học của trường vẫn nằm ở bảng
 * `subjects` (kèm hợp đồng, số HS, số tiết...). Bảng này chỉ là danh sách
 * option để nhân viên kinh doanh chọn khi tạo môn học cho trường.
 */
@Entity('subject_catalogs')
export class SubjectCatalog {
    @PrimaryGeneratedColumn()
    id!: number;

    /** Tên môn học hiển thị cho NVKD chọn. Không trùng nhau (không phân biệt hoa/thường). */
    @Column({ length: 255, unique: true })
    name!: string;

    /** Mã môn tuỳ chọn do sales admin đặt (VD: STEM, KNS, CDS). */
    @Column({ type: 'varchar', length: 50, nullable: true })
    code?: string | null;

    @Column({ type: 'text', nullable: true })
    description?: string | null;

    /** false = ngừng sử dụng: không hiện trong danh sách chọn, dữ liệu cũ vẫn giữ nguyên. */
    @Column({ name: 'is_active', type: 'boolean', default: true })
    @Index('IDX_subject_catalogs_is_active')
    isActive!: boolean;

    /** Thứ tự hiển thị trong dropdown (nhỏ hơn hiện trước). */
    @Column({ name: 'sort_order', type: 'int', default: 0 })
    sortOrder!: number;

    @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
    updatedAt!: Date;

    @OneToMany(() => Subject, (s) => s.catalog)
    subjects!: Subject[];
}

/** Chuẩn hoá tên môn: bỏ khoảng trắng thừa để so sánh/lưu nhất quán. */
export function normalizeSubjectName(name: string): string {
    return name.replace(/\s+/g, ' ').trim();
}
