import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { School } from '../school/schools.entity';
import { Subject } from '../subject/subject.entity';
import { SchoolClass } from '../teaching/entities/school-class.entity';
import { Teacher } from '../teaching/entities/teacher.entity';

import { normalize, rank, schoolCore, schoolKind } from './text-match';

export interface Option {
    id: number;
    name: string;
    hint?: string;
}

/**
 * Tra ID trường / môn / giáo viên / lớp từ tên đọc được trên ảnh.
 *
 * Khớp được đúng một mục thì chốt luôn; khớp nhiều mục thì trả cả danh sách để
 * chatbot hỏi lại. Không bao giờ tự chọn khi còn mơ hồ — chọn nhầm trường là
 * xếp cả thời khoá biểu vào sai nơi.
 */
@Injectable()
export class TimetableResolverService {
    constructor(
        @InjectRepository(School)
        private readonly schools: Repository<School>,
        @InjectRepository(Teacher)
        private readonly teachers: Repository<Teacher>,
        @InjectRepository(Subject)
        private readonly subjects: Repository<Subject>,
        @InjectRepository(SchoolClass)
        private readonly classes: Repository<SchoolClass>,
    ) {}

    async findSchools(name: string | null | undefined): Promise<Option[]> {
        if (!name?.trim()) return [];

        const all = await this.schools.find({ select: ['id', 'name'] });
        const wantedKind = schoolKind(name);

        return rank(all, schoolCore(name), (s) => schoolCore(s.name), {
            // "Tiểu học Phước Hiệp" và "Mầm non Phước Hiệp" có phần tên riêng
            // giống hệt nhau; loại hình trường là thứ duy nhất tách được chúng.
            bonus: (s) =>
                wantedKind && schoolKind(s.name) === wantedKind ? 0.25 : 0,
        }).map(({ item }) => ({ id: item.id, name: item.name }));
    }

    async findTeachers(name: string | null | undefined): Promise<Option[]> {
        if (!name?.trim()) return [];

        const all = await this.teachers.find({
            where: { isActive: true },
            select: ['id', 'name', 'phone'],
        });

        return rank(all, name, (t) => t.name).map(({ item }) => ({
            id: item.id,
            name: item.name,
            hint: item.phone ?? undefined,
        }));
    }

    /** Danh sách giáo viên đang dùng — dùng khi ảnh không ghi tên người nào. */
    async listTeachers(): Promise<Option[]> {
        const all = await this.teachers.find({
            where: { isActive: true },
            select: ['id', 'name', 'phone'],
            order: { name: 'ASC' },
        });
        return all.map((t) => ({
            id: t.id,
            name: t.name,
            hint: t.phone ?? undefined,
        }));
    }

    /**
     * Môn là bản ghi riêng của **từng trường** kèm hợp đồng và năm học, nên chỉ
     * tìm trong phạm vi trường đã chốt.
     */
    async findSubjects(
        schoolId: number | null,
        schoolYear: string | null,
        name: string | null | undefined,
    ): Promise<Option[]> {
        if (!schoolId) return [];

        const where: Record<string, unknown> = { schoolId };
        if (schoolYear) where.schoolYear = schoolYear;

        const all = await this.subjects.find({
            where,
            select: ['id', 'name', 'schoolYear'],
        });

        // Trường thường chỉ khai vài môn; không khớp được tên thì trả hết để
        // Nhân sự chọn, vẫn nhanh hơn bắt họ mở màn hình khác.
        const matched = name?.trim() ? rank(all, name, (s) => s.name) : [];
        const chosen = matched.length > 0 ? matched.map((c) => c.item) : all;

        return chosen.map((s) => ({
            id: s.id,
            name: s.name,
            hint: s.schoolYear ?? undefined,
        }));
    }

    /** Lớp hiện có của trường trong năm học, khoá theo tên đã chuẩn hoá. */
    async findClasses(
        schoolId: number,
        schoolYear: string,
    ): Promise<Map<string, SchoolClass>> {
        const rows = await this.classes.find({ where: { schoolId, schoolYear } });
        return new Map(rows.map((row) => [normalize(row.name), row]));
    }
}
