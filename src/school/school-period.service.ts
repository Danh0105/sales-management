import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { School } from './schools.entity';
import { SchoolPeriod } from './entities/school-period.entity';
import { ReplaceSchoolPeriodsDto, SchoolPeriodItemDto } from './dto/school-period.dto';
import { toDbTime, toDisplayTime } from '../teaching/teaching.util';

@Injectable()
export class SchoolPeriodService {
  constructor(
    @InjectRepository(SchoolPeriod)
    private readonly periodRepo: Repository<SchoolPeriod>,

    @InjectRepository(School)
    private readonly schoolRepo: Repository<School>,

    private readonly dataSource: DataSource,
  ) {}

  async findBySchool(schoolId: number) {
    await this.assertSchoolExists(schoolId);

    const rows = await this.periodRepo.find({
      where: { schoolId },
      order: { periodNo: 'ASC' },
    });

    return rows.map((row) => this.toItem(row));
  }

  /**
   * Thay toàn bộ bảng tiết của trường. Chạy trong transaction: xoá rồi ghi lại,
   * đứt gánh giữa chừng mà không có transaction thì trường mất sạch bảng tiết.
   */
  async replace(schoolId: number, dto: ReplaceSchoolPeriodsDto) {
    await this.assertSchoolExists(schoolId);
    this.assertValidPeriods(dto.periods);

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(SchoolPeriod);
      await repo.delete({ schoolId });

      if (dto.periods.length) {
        await repo.save(
          dto.periods.map((item) =>
            repo.create({
              schoolId,
              periodNo: item.periodNo,
              startTime: toDbTime(item.startTime),
              endTime: toDbTime(item.endTime),
              label: item.label?.trim() || null,
              session: item.session ?? 'SANG',
              isPeriod: item.isPeriod ?? true,
            }),
          ),
        );
      }
    });

    return {
      periods: await this.findBySchool(schoolId),
      warnings: this.overlapWarnings(dto.periods),
    };
  }

  /**
   * Chỉ chặn dữ liệu HỎNG, không chặn bố cục người dùng đang sắp.
   *
   * Trước đây chồng giờ bị ném 400 → cả lần lưu bị huỷ. Nhưng lưới TKB tự lưu
   * khi gõ, mà sửa khung giờ thì gần như luôn đi qua trạng thái chồng giờ tạm
   * thời (kéo dài tiết này trước, dời tiết kế sau) — thành ra người dùng sửa
   * cả loạt mà không có gì được lưu, lại còn nhận thông báo nhắc tới số thứ tự
   * dòng mà trên lưới không hề hiển thị. Giờ chồng giờ chỉ là CẢNH BÁO trả
   * kèm, việc lưu vẫn diễn ra.
   */
  private assertValidPeriods(periods: SchoolPeriodItemDto[]) {
    const seen = new Set<number>();

    for (const item of periods) {
      if (seen.has(item.periodNo)) {
        throw new BadRequestException(
          `${this.rowName(item)} bị khai trùng số thứ tự`,
        );
      }
      seen.add(item.periodNo);

      if (toDbTime(item.startTime) >= toDbTime(item.endTime)) {
        throw new BadRequestException(
          `${this.rowName(item)}: giờ bắt đầu phải nhỏ hơn giờ kết thúc`,
        );
      }
    }
  }

  /**
   * Tên dòng theo đúng thứ người dùng NHÌN THẤY trên lưới ("SÁNG · tiết 2",
   * "CHIỀU · RA CHƠI") thay vì số thứ tự nội bộ — báo "tiết 8" trong khi lưới
   * chỉ đánh số 1–4 mỗi buổi thì không ai lần ra được dòng nào.
   */
  private rowName(item: SchoolPeriodItemDto): string {
    const buoi = item.session === 'CHIEU' ? 'CHIỀU' : 'SÁNG';
    const label = item.label?.trim();
    if (!label) return `${buoi} · dòng ${item.periodNo}`;
    return item.isPeriod === false
      ? `${buoi} · ${label}`
      : `${buoi} · tiết ${label}`;
  }

  /** Các cặp dòng chồng giờ — trả kèm để FE nhắc, không chặn lưu. */
  private overlapWarnings(periods: SchoolPeriodItemDto[]): string[] {
    const sorted = [...periods].sort((a, b) =>
      toDbTime(a.startTime).localeCompare(toDbTime(b.startTime)),
    );

    const warnings: string[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const current = sorted[i];
      if (toDbTime(current.startTime) < toDbTime(prev.endTime)) {
        warnings.push(
          `${this.rowName(prev)} và ${this.rowName(current)} bị chồng giờ`,
        );
      }
    }
    return warnings;
  }

  private async assertSchoolExists(schoolId: number) {
    const exists = await this.schoolRepo.exist({ where: { id: schoolId } });
    if (!exists) throw new NotFoundException('Trường không tồn tại');
  }

  private toItem(row: SchoolPeriod) {
    return {
      id: row.id,
      schoolId: row.schoolId,
      periodNo: row.periodNo,
      startTime: toDisplayTime(row.startTime),
      endTime: toDisplayTime(row.endTime),
      label: row.label ?? null,
      session: row.session ?? 'SANG',
      isPeriod: row.isPeriod ?? true,
    };
  }
}
