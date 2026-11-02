import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AuthUser } from '../type/auth-user.type';
import { CashAccount } from './cash-account.entity';
import { CashManualEntry } from './cash-manual-entry.entity';
import { centsToString, toCents } from './cashflow-money';
import {
  CreateManualEntryDto,
  UpdateManualEntryDto,
} from './dto/manual-entry.dto';
import { manualDocumentNo } from './manual-entry-source';

function isValidDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

/** Thêm / sửa / xoá bút toán thu chi nhập tay trên Tổng hợp thu chi. */
@Injectable()
export class CashManualEntryService {
  constructor(
    @InjectRepository(CashManualEntry)
    private readonly entryRepository: Repository<CashManualEntry>,
    @InjectRepository(CashAccount)
    private readonly accountRepository: Repository<CashAccount>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async get(id: number) {
    return this.toView(await this.find(id));
  }

  async create(dto: CreateManualEntryDto, user: AuthUser) {
    const entry = this.entryRepository.create({
      kind: dto.kind,
      entryDate: dto.entryDate,
      accountCode: dto.accountCode,
      counterAccountCode: dto.counterAccountCode ?? null,
      amount: dto.amount,
      documentNo: dto.documentNo ?? null,
      description: dto.description,
      partnerName: dto.partnerName ?? null,
      note: dto.note ?? null,
      createdBy: user.id,
      createdByName: await this.actorName(user),
    });
    await this.validate(entry, null);
    return this.toView(await this.entryRepository.save(entry));
  }

  async update(id: number, dto: UpdateManualEntryDto, user: AuthUser) {
    const entry = await this.find(id);
    const before = { ...entry };
    for (const field of [
      'kind',
      'entryDate',
      'accountCode',
      'counterAccountCode',
      'amount',
      'documentNo',
      'description',
      'partnerName',
      'note',
    ] as const) {
      if (dto[field] !== undefined) {
        (entry as unknown as Record<string, unknown>)[field] = dto[field];
      }
    }
    // Đổi khỏi Chuyển nội bộ thì bỏ tài khoản nhận.
    if (entry.kind !== 'TRANSFER') entry.counterAccountCode = null;
    await this.validate(entry, before);
    entry.updatedBy = user.id;
    entry.updatedByName = await this.actorName(user);
    return this.toView(await this.entryRepository.save(entry));
  }

  /** Xoá mềm: dòng ra khỏi sổ nhưng vẫn giữ để tra lại. */
  async remove(id: number, user: AuthUser) {
    const entry = await this.find(id);
    entry.deletedAt = new Date();
    entry.deletedBy = user.id;
    entry.deletedByName = await this.actorName(user);
    await this.entryRepository.save(entry);
    return { id, deleted: true };
  }

  private async find(id: number) {
    const entry = await this.entryRepository.findOne({
      where: { id, deletedAt: IsNull() },
    });
    if (!entry) throw new NotFoundException('Không tìm thấy bút toán');
    return entry;
  }

  /**
   * Ngày thật, số tiền > 0, tài khoản có trong danh mục; chọn tài khoản mới thì
   * phải đang sử dụng (giữ nguyên tài khoản cũ đã ngừng dùng vẫn được).
   */
  private async validate(
    entry: CashManualEntry,
    before: Pick<CashManualEntry, 'accountCode' | 'counterAccountCode'> | null,
  ) {
    if (!isValidDate(entry.entryDate)) {
      throw new BadRequestException('Ngày hạch toán không hợp lệ');
    }
    const cents = toCents(entry.amount);
    if (cents <= 0n) {
      throw new BadRequestException('Số tiền phải lớn hơn 0');
    }
    entry.amount = centsToString(cents);

    const codes = [entry.accountCode];
    if (entry.kind === 'TRANSFER') {
      if (!entry.counterAccountCode) {
        throw new BadRequestException('Chuyển nội bộ phải chọn tài khoản nhận');
      }
      if (entry.counterAccountCode === entry.accountCode) {
        throw new BadRequestException(
          'Tài khoản chuyển đi và tài khoản nhận phải khác nhau',
        );
      }
      codes.push(entry.counterAccountCode);
    } else {
      entry.counterAccountCode = null;
    }

    const kept = new Set(
      [before?.accountCode, before?.counterAccountCode].filter(Boolean),
    );
    for (const code of codes) {
      const account = await this.accountRepository.findOne({ where: { code } });
      if (!account) {
        throw new BadRequestException(
          `Tài khoản "${code}" không có trong danh mục`,
        );
      }
      if (!account.isActive && !kept.has(code)) {
        throw new BadRequestException(
          `Tài khoản ${code} đã ngừng sử dụng — chọn tài khoản khác`,
        );
      }
    }
  }

  /** Token có thể thiếu tên — lấy từ hồ sơ nhân viên. */
  private async actorName(user: AuthUser): Promise<string | null> {
    if (user.name) return user.name;
    const [row] = await this.dataSource.query<{ name: string }[]>(
      'SELECT name FROM employee WHERE id = $1',
      [user.id],
    );
    return row?.name ?? null;
  }

  private toView(entry: CashManualEntry) {
    return {
      id: entry.id,
      kind: entry.kind,
      entryDate: entry.entryDate,
      accountCode: entry.accountCode,
      counterAccountCode: entry.counterAccountCode,
      amount: centsToString(toCents(entry.amount)),
      documentNo: entry.documentNo,
      displayDocumentNo: manualDocumentNo({
        id: entry.id,
        kind: entry.kind,
        document_no: entry.documentNo,
      }),
      description: entry.description,
      partnerName: entry.partnerName,
      note: entry.note,
      createdByName: entry.createdByName,
      createdAt: entry.createdAt,
      updatedByName: entry.updatedByName,
      updatedAt: entry.updatedAt,
    };
  }
}
