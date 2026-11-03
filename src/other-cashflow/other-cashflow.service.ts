import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { promises as fs } from 'fs';
import { extname } from 'path';
import { DataSource, EntityManager, Not, Repository } from 'typeorm';

import { CashAccount } from '../cashflow-report/cash-account.entity';
import { Employee } from '../employee/employee.entity';
import { vnToday } from '../financial-request/financial-calculations';
import {
  formatVnd,
  lineAmount,
  sumMoney,
  toSafeMoney,
} from '../financial-request/financial-money';
import {
  absolutePath,
  decodeOriginalName,
  openStoredFile,
  storeFile,
} from '../financial-request/financial-storage';
import { School } from '../school/schools.entity';
import { AuthUser } from '../type/auth-user.type';
import {
  CreateOrderDto,
  CreateOtherCashflowDto,
  ExecuteOrderDto,
  ListOtherCashflowDto,
  OtherCashflowCostDto,
  OtherCashflowItemDto,
  ReasonDto,
  RecordEntryDto,
  ReviewOtherCashflowDto,
  UpdateOtherCashflowDto,
  UploadAttachmentDto,
} from './dto/other-cashflow.dto';
import { OtherCashflowAttachment } from './entities/other-cashflow-attachment.entity';
import { OtherCashflowContract } from './entities/other-cashflow-contract.entity';
import { OtherCashflowCost } from './entities/other-cashflow-cost.entity';
import { OtherCashflowEntry } from './entities/other-cashflow-entry.entity';
import { OtherCashflowEvent } from './entities/other-cashflow-event.entity';
import { OtherCashflowItem } from './entities/other-cashflow-item.entity';
import { OtherCashflowOrder } from './entities/other-cashflow-order.entity';
import {
  canApprove,
  canCancel,
  canCreate,
  canCreateOrder,
  canDeleteContractFile,
  canEdit,
  canExecuteOrder,
  canManageDebt,
  canManageEvidence,
  canRecord,
  canRecordEntry,
  canReview,
  canUploadContractFile,
  canUseModule,
  canView,
  canViewAll,
  permissionsOf,
} from './other-cashflow-access';
import {
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_MAX_FILES_PER_CONTRACT,
  ATTACHMENT_MAX_FILES_PER_UPLOAD,
  CashflowDirection,
  contractCode,
  EntryStatus,
  OrderKind,
  OrderStatus,
  OtherCashflowAttachmentKind,
  OtherCashflowForm,
  OtherCashflowStatus,
  STORAGE_FOLDER,
} from './other-cashflow.constants';
import { OtherCashflowNotifyService } from './other-cashflow-notify.service';

interface Actor {
  id: number;
  name: string | null;
}

type Progress = Pick<
  OtherCashflowContract,
  'amount' | 'recordedAmount' | 'costAmount' | 'paidCostAmount'
>;

/**
 * Trạng thái sau khi số đã thu/chi thay đổi: hoàn tất khi đã thu đủ tổng phải
 * thu VÀ đã chi đủ các khoản chi.
 */
export function statusForProgress(progress: Progress): OtherCashflowStatus {
  if (progress.recordedAmount <= 0 && progress.paidCostAmount <= 0) {
    return OtherCashflowStatus.APPROVED;
  }
  return progress.recordedAmount >= progress.amount &&
    progress.paidCostAmount >= progress.costAmount
    ? OtherCashflowStatus.COMPLETED
    : OtherCashflowStatus.IN_PROGRESS;
}

/** "TCN-00012" / "tcn12" / "12" → 12. */
export function parseContractCode(search: string): number | null {
  const match = /^(?:tcn-?)?0*(\d{1,9})$/i.exec(search.trim());
  return match ? Number(match[1]) : null;
}

const ZERO_DECIMAL = /^0+(\.0+)?$/;

/** Thuế VAT của số tiền chưa thuế, làm tròn nửa lên tới đồng; trống = không thuế. */
export function vatOf(net: number, rate: number | null | undefined): number {
  if (!rate) return 0;
  return toSafeMoney((BigInt(net) * BigInt(rate) * 2n + 100n) / 200n);
}

/** Lợi nhuận dự kiến = tổng thu chưa thuế − tổng chi chưa thuế (VAT không phải lãi). */
export function profitOf(
  contract: Pick<
    OtherCashflowContract,
    'amount' | 'incomeVatAmount' | 'costAmount' | 'costVatAmount'
  >,
): number {
  return (
    contract.amount -
    contract.incomeVatAmount -
    (contract.costAmount - contract.costVatAmount)
  );
}

function priceLine(
  line: OtherCashflowItemDto | OtherCashflowCostDto,
  label: string,
) {
  if (ZERO_DECIMAL.test(line.quantity)) {
    throw new BadRequestException(`${label}: số lượng phải lớn hơn 0`);
  }
  const amount = lineAmount(line.quantity, line.unitPrice);
  const vatRate = line.vatRate ?? null;
  const vatAmount = vatOf(amount, vatRate);
  return {
    itemCode: line.itemCode || null,
    unit: line.unit || null,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    amount,
    vatRate,
    vatAmount,
    totalAmount: toSafeMoney(amount + vatAmount, `${label}: thành tiền`),
  };
}

/**
 * Khoản thu + khoản chi của hợp đồng, thành tiền và thuế tính lại ở backend.
 * Số tiền hợp đồng: tổng phải thu / phải chi gồm thuế.
 */
export function buildLines(
  items: OtherCashflowItemDto[],
  costs: OtherCashflowCostDto[],
) {
  if (!items.length && !costs.length) {
    throw new BadRequestException('Hợp đồng cần ít nhất một khoản thu hoặc khoản chi');
  }
  const itemRows = items.map((item, index) => ({
    lineNo: index + 1,
    itemName: item.itemName,
    ...priceLine(item, `Khoản thu ${index + 1}`),
  }));
  const costRows = costs.map((cost, index) => {
    const priced = priceLine(cost, `Khoản chi ${index + 1}`);
    if (priced.totalAmount <= 0) {
      throw new BadRequestException(`Khoản chi ${index + 1}: số tiền phải lớn hơn 0`);
    }
    return {
      lineNo: index + 1,
      description: cost.description,
      payee: cost.payee || null,
      ...priced,
      paidAmount: 0,
    };
  });
  const amount = sumMoney(itemRows.map((row) => row.totalAmount));
  const costAmount = sumMoney(costRows.map((row) => row.totalAmount));
  if (amount + costAmount <= 0) {
    throw new BadRequestException('Tổng tiền hợp đồng phải lớn hơn 0');
  }
  return {
    items: itemRows,
    costs: costRows,
    amount,
    incomeVatAmount: sumMoney(itemRows.map((row) => row.vatAmount)),
    costAmount,
    costVatAmount: sumMoney(costRows.map((row) => row.vatAmount)),
  };
}

@Injectable()
export class OtherCashflowService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(OtherCashflowContract)
    private readonly contractRepo: Repository<OtherCashflowContract>,
    @InjectRepository(OtherCashflowEntry)
    private readonly entryRepo: Repository<OtherCashflowEntry>,
    @InjectRepository(OtherCashflowAttachment)
    private readonly attachmentRepo: Repository<OtherCashflowAttachment>,
    @InjectRepository(OtherCashflowEvent)
    private readonly eventRepo: Repository<OtherCashflowEvent>,
    @InjectRepository(OtherCashflowItem)
    private readonly itemRepo: Repository<OtherCashflowItem>,
    @InjectRepository(OtherCashflowCost)
    private readonly costRepo: Repository<OtherCashflowCost>,
    @InjectRepository(OtherCashflowOrder)
    private readonly orderRepo: Repository<OtherCashflowOrder>,
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
    private readonly notify: OtherCashflowNotifyService,
  ) {}

  // ---------------------------------------------------------------------------
  // Đọc
  // ---------------------------------------------------------------------------

  async list(user: AuthUser, query: ListOtherCashflowDto) {
    if (!canUseModule(user)) {
      throw new ForbiddenException('Bạn không có quyền xem Thu Chi ngoài');
    }
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const scoped = () => {
      const qb = this.contractRepo
        .createQueryBuilder('c')
        .leftJoin('c.school', 's');
      if (!canViewAll(user)) {
        qb.andWhere('c.createdById = :me', { me: user.id });
      }
      if (query.form) {
        qb.andWhere('c.form = :form', { form: query.form });
      }
      if (query.search) {
        const id = parseContractCode(query.search);
        qb.andWhere(
          `(c.title ILIKE :q OR c.partnerName ILIKE :q OR c.createdByName ILIKE :q OR c.documentNo ILIKE :q OR s.name ILIKE :q${id ? ' OR c.id = :id' : ''})`,
          { q: `%${query.search.replace(/[%_\\]/g, '\\$&')}%`, id },
        );
      }
      return qb;
    };

    const listQb = scoped()
      .addSelect(['s.id', 's.name'])
      .orderBy('c.submittedAt', 'DESC')
      .addOrderBy('c.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (query.status) {
      listQb.andWhere('c.status = :status', { status: query.status });
    }

    const [[data, total], countRows] = await Promise.all([
      listQb.getManyAndCount(),
      scoped()
        .select('c.status', 'status')
        .addSelect('COUNT(*)::int', 'count')
        .groupBy('c.status')
        .getRawMany<{ status: OtherCashflowStatus; count: number }>(),
    ]);

    const counts = Object.fromEntries(
      Object.values(OtherCashflowStatus).map((status) => [status, 0]),
    ) as Record<OtherCashflowStatus, number>;
    for (const row of countRows) counts[row.status] = Number(row.count);

    return {
      data: data.map((contract) => this.present(contract)),
      total,
      page,
      limit,
      counts,
      meta: {
        canCreate: canCreate(user),
        canApprove: canApprove(user),
        canRecord: canRecord(user),
        canManageDebt: canManageDebt(user),
        canViewAll: canViewAll(user),
      },
    };
  }

  async detail(user: AuthUser, id: number) {
    const contract = await this.contractRepo.findOne({
      where: { id },
      relations: { school: true },
    });
    if (!contract || !canView(user, contract)) {
      throw new NotFoundException('Không tìm thấy hợp đồng thu chi ngoài');
    }
    const byId = { order: { id: 'ASC' as const } };
    const [entries, attachments, events, items, costs, orders] =
      await Promise.all([
        this.entryRepo.find({
          where: { contractId: id },
          order: { entryDate: 'ASC', id: 'ASC' },
        }),
        this.attachmentRepo.find({ where: { contractId: id }, ...byId }),
        this.eventRepo.find({ where: { contractId: id }, ...byId }),
        this.itemRepo.find({
          where: { contractId: id },
          order: { lineNo: 'ASC' },
        }),
        this.costRepo.find({
          where: { contractId: id },
          order: { lineNo: 'ASC' },
        }),
        this.orderRepo.find({ where: { contractId: id }, ...byId }),
      ]);
    return {
      ...this.present(contract),
      items,
      costs,
      orders,
      entries,
      attachments: attachments
        .filter((file) => !file.deletedAt)
        .map(({ storagePath: _path, sha256: _sha, ...file }) => file),
      events,
      permissions: permissionsOf(user, contract),
    };
  }

  private present(contract: OtherCashflowContract) {
    const incomeNetAmount = contract.amount - contract.incomeVatAmount;
    const costNetAmount = contract.costAmount - contract.costVatAmount;
    return {
      ...contract,
      code: contractCode(contract.id),
      remainingAmount: contract.amount - contract.recordedAmount,
      remainingCostAmount: contract.costAmount - contract.paidCostAmount,
      incomeNetAmount,
      costNetAmount,
      /** VAT phải nộp = đầu ra − đầu vào (âm = được khấu trừ). */
      vatPayable: contract.incomeVatAmount - contract.costVatAmount,
      profit: profitOf(contract),
      school: contract.school
        ? { id: contract.school.id, name: contract.school.name }
        : null,
    };
  }

  // ---------------------------------------------------------------------------
  // NV kinh doanh: lập / sửa & gửi lại / huỷ
  // ---------------------------------------------------------------------------

  async create(user: AuthUser, dto: CreateOtherCashflowDto) {
    if (!canCreate(user)) {
      throw new ForbiddenException(
        'Chỉ nhân viên kinh doanh lập hợp đồng thu chi ngoài',
      );
    }
    const form = dto.form ?? OtherCashflowForm.STANDARD;
    const lines = buildLines(dto.items ?? [], dto.costs ?? []);
    const actor = await this.actor(user);
    const saved = await this.dataSource.transaction(async (manager) => {
      await this.assertSchool(manager, dto.schoolId);
      const repo = manager.getRepository(OtherCashflowContract);
      const contract = await repo.save(
        repo.create({
          direction: null,
          form,
          title: dto.title,
          documentNo: dto.documentNo || null,
          partnerName: dto.partnerName,
          schoolId: dto.schoolId ?? null,
          amount: lines.amount,
          incomeVatAmount: lines.incomeVatAmount,
          costAmount: lines.costAmount,
          costVatAmount: lines.costVatAmount,
          paidCostAmount: 0,
          signedDate: dto.signedDate ?? null,
          expectedDate: dto.expectedDate ?? null,
          note: dto.note || null,
          status: OtherCashflowStatus.PENDING,
          recordedAmount: 0,
          createdById: actor.id,
          createdByName: actor.name,
          submittedAt: new Date(),
        }),
      );
      await this.replaceLines(manager, contract.id, lines);
      await this.log(manager, contract.id, actor, 'SUBMITTED', {
        to: OtherCashflowStatus.PENDING,
        changes: this.snapshot(contract),
      });
      return contract;
    });
    await this.notify.reviewRequired(saved, false);
    return this.detail(user, saved.id);
  }

  async update(user: AuthUser, id: number, dto: UpdateOtherCashflowDto) {
    const actor = await this.actor(user);
    const { contract, resubmitted } = await this.dataSource.transaction(
      async (manager) => {
        const contract = await this.lock(manager, id);
        if (!canEdit(user, contract)) {
          throw new ForbiddenException(
            'Chỉ người lập sửa được khi hợp đồng đang chờ duyệt hoặc bị từ chối',
          );
        }
        if (dto.schoolId !== undefined) {
          await this.assertSchool(manager, dto.schoolId);
        }
        const before = this.snapshot(contract);
        const from = contract.status;
        // Không gửi lại khoản thu / khoản chi = giữ nguyên bộ đang có.
        const lines = buildLines(
          dto.items ?? (await this.itemDtos(manager, id)),
          dto.costs ?? (await this.costDtos(manager, id)),
        );

        // Sửa lại hợp đồng lập trước khi gộp → thành hợp đồng gộp thu chi.
        contract.direction = null;
        if (dto.form !== undefined) contract.form = dto.form;
        if (dto.title !== undefined) contract.title = dto.title;
        if (dto.documentNo !== undefined)
          contract.documentNo = dto.documentNo || null;
        if (dto.partnerName !== undefined) contract.partnerName = dto.partnerName;
        if (dto.schoolId !== undefined) contract.schoolId = dto.schoolId ?? null;
        contract.amount = lines.amount;
        contract.incomeVatAmount = lines.incomeVatAmount;
        contract.costAmount = lines.costAmount;
        contract.costVatAmount = lines.costVatAmount;
        if (dto.signedDate !== undefined)
          contract.signedDate = dto.signedDate ?? null;
        if (dto.expectedDate !== undefined)
          contract.expectedDate = dto.expectedDate ?? null;
        if (dto.note !== undefined) contract.note = dto.note || null;
        contract.status = OtherCashflowStatus.PENDING;
        contract.submittedAt = new Date();
        contract.reviewedById = null;
        contract.reviewedByName = null;
        contract.reviewedAt = null;
        contract.reviewNote = null;
        await manager.getRepository(OtherCashflowContract).save(contract);
        // Chưa duyệt nên chưa có phiếu/lần chi nào trỏ tới dòng cũ — thay cả bộ.
        await this.replaceLines(manager, id, lines);
        await this.log(
          manager,
          id,
          actor,
          from === OtherCashflowStatus.REJECTED ? 'RESUBMITTED' : 'UPDATED',
          {
            from,
            to: OtherCashflowStatus.PENDING,
            changes: { before, after: this.snapshot(contract) },
          },
        );
        return {
          contract,
          resubmitted: from === OtherCashflowStatus.REJECTED,
        };
      },
    );
    // Sửa khi đang chờ duyệt: thông báo cũ vẫn trỏ đúng hợp đồng, chỉ báo lại khi gửi lại.
    if (resubmitted) await this.notify.reviewRequired(contract, true);
    return this.detail(user, id);
  }

  async cancel(user: AuthUser, id: number, dto: ReasonDto) {
    const actor = await this.actor(user);
    const contract = await this.dataSource.transaction(async (manager) => {
      const contract = await this.lock(manager, id);
      if (!canCancel(user, contract)) {
        throw new ForbiddenException(
          contract.recordedAmount > 0 || contract.paidCostAmount > 0
            ? 'Hợp đồng đã có khoản thu/chi — huỷ các lần ghi nhận trước'
            : 'Bạn không huỷ được hợp đồng này',
        );
      }
      const openOrders = await manager.getRepository(OtherCashflowOrder).count({
        where: { contractId: id, status: Not(OrderStatus.CANCELLED) },
      });
      if (openOrders > 0) {
        throw new BadRequestException(
          'Đơn đã có phiếu thu/lệnh chi — kế toán công nợ huỷ các phiếu trước',
        );
      }
      const from = contract.status;
      contract.status = OtherCashflowStatus.CANCELLED;
      contract.cancelledAt = new Date();
      contract.cancelReason = dto.reason;
      await manager.getRepository(OtherCashflowContract).save(contract);
      await this.log(manager, id, actor, 'CANCELLED', {
        from,
        to: contract.status,
        note: dto.reason,
      });
      return contract;
    });
    await this.notify.closeReviewRequests(id);
    await this.notify.cancelled(contract, actor);
    return this.detail(user, id);
  }

  // ---------------------------------------------------------------------------
  // Giám đốc: duyệt / từ chối
  // ---------------------------------------------------------------------------

  async review(user: AuthUser, id: number, dto: ReviewOtherCashflowDto) {
    if (!canApprove(user)) {
      throw new ForbiddenException('Chỉ giám đốc duyệt hợp đồng thu chi ngoài');
    }
    const approve = dto.decision === OtherCashflowStatus.APPROVED;
    if (!approve && !dto.note) {
      throw new BadRequestException('Vui lòng nhập lý do từ chối');
    }
    const actor = await this.actor(user);
    const contract = await this.dataSource.transaction(async (manager) => {
      const contract = await this.lock(manager, id);
      if (!canReview(user, contract)) {
        throw new ConflictException(
          'Hợp đồng không còn ở trạng thái chờ duyệt — tải lại để xem',
        );
      }
      contract.status = dto.decision;
      contract.reviewedById = actor.id;
      contract.reviewedByName = actor.name;
      contract.reviewedAt = new Date();
      contract.reviewNote = dto.note || null;
      await manager.getRepository(OtherCashflowContract).save(contract);
      await this.log(manager, id, actor, approve ? 'APPROVED' : 'REJECTED', {
        from: OtherCashflowStatus.PENDING,
        to: contract.status,
        note: dto.note || null,
      });
      return contract;
    });
    await this.notify.closeReviewRequests(id);
    await this.notify.reviewed(contract, actor);
    return this.detail(user, id);
  }

  // ---------------------------------------------------------------------------
  // Thủ quỹ: thu/chi trực tiếp (hình thức Thông thường) / huỷ lần thu/chi
  // ---------------------------------------------------------------------------

  async recordEntry(user: AuthUser, id: number, dto: RecordEntryDto) {
    if (!canRecord(user)) {
      throw new ForbiddenException('Chỉ thủ quỹ ghi nhận thu chi');
    }
    this.assertNotFuture(dto.date);
    const actor = await this.actor(user);
    const result = await this.dataSource.transaction(async (manager) => {
      const contract = await this.lock(manager, id);
      const existing = await this.replayed(manager, id, dto.idempotencyKey);
      if (existing) return { contract, entry: existing, cost: null, replay: true };
      if (contract.form === OtherCashflowForm.COMMERCIAL) {
        throw new BadRequestException(
          'Đơn Thương mại thu/chi theo phiếu thu, lệnh chi của kế toán công nợ',
        );
      }
      if (!canRecordEntry(user, contract)) {
        throw new BadRequestException(
          'Chỉ thu/chi cho hợp đồng đã duyệt và chưa thu/chi đủ',
        );
      }
      const receipt = dto.flow === CashflowDirection.IN;
      let cost: OtherCashflowCost | null = null;
      if (receipt) {
        const remaining = contract.amount - contract.recordedAmount;
        if (dto.amount > remaining) {
          throw new BadRequestException(
            `Số tiền ${formatVnd(dto.amount)} đ vượt số còn phải thu ${formatVnd(remaining)} đ`,
          );
        }
      } else {
        // findOne với id undefined trả dòng bất kỳ — chặn trước.
        if (!dto.costId) throw new BadRequestException('Vui lòng chọn khoản chi');
        cost = await manager
          .getRepository(OtherCashflowCost)
          .findOne({ where: { id: dto.costId, contractId: id } });
        if (!cost) {
          throw new BadRequestException('Khoản chi không thuộc hợp đồng này');
        }
        const remaining = cost.totalAmount - cost.paidAmount;
        if (dto.amount > remaining) {
          throw new BadRequestException(
            `Số tiền ${formatVnd(dto.amount)} đ vượt khoản chi "${cost.description}" còn phải chi ${formatVnd(remaining)} đ`,
          );
        }
      }
      await this.assertCashAccount(manager, dto.cashAccountCode);
      const entries = manager.getRepository(OtherCashflowEntry);
      const entry = await entries.save(
        entries.create({
          contractId: id,
          flow: dto.flow,
          orderId: null,
          costId: cost?.id ?? null,
          entryDate: dto.date,
          amount: dto.amount,
          cashAccountCode: dto.cashAccountCode,
          note: dto.note || null,
          idempotencyKey: dto.idempotencyKey,
          status: EntryStatus.RECORDED,
          recordedById: actor.id,
          recordedByName: actor.name,
        }),
      );
      const from = contract.status;
      if (cost) {
        cost.paidAmount += dto.amount;
        await manager.getRepository(OtherCashflowCost).save(cost);
        contract.paidCostAmount += dto.amount;
      } else {
        contract.recordedAmount += dto.amount;
      }
      contract.status = statusForProgress(contract);
      await manager.getRepository(OtherCashflowContract).save(contract);
      await this.log(manager, id, actor, 'ENTRY_RECORDED', {
        from,
        to: contract.status,
        note: dto.note || null,
        changes: {
          entryId: entry.id,
          flow: dto.flow,
          costId: entry.costId,
          date: dto.date,
          amount: dto.amount,
          cashAccountCode: dto.cashAccountCode,
        },
      });
      return { contract, entry, cost, replay: false };
    });
    if (!result.replay) {
      await this.notify.recorded(
        result.contract,
        result.entry,
        result.cost?.description ?? null,
        actor,
      );
    }
    return result.entry;
  }

  async voidEntry(user: AuthUser, id: number, entryId: number, dto: ReasonDto) {
    if (!canRecord(user)) {
      throw new ForbiddenException('Chỉ thủ quỹ huỷ lần thu/chi');
    }
    const actor = await this.actor(user);
    await this.dataSource.transaction(async (manager) => {
      const contract = await this.lock(manager, id);
      const entries = manager.getRepository(OtherCashflowEntry);
      const entry = await entries.findOne({ where: { id: entryId, contractId: id } });
      if (!entry) throw new NotFoundException('Không tìm thấy lần thu/chi');
      if (entry.status !== EntryStatus.RECORDED) {
        throw new ConflictException('Lần thu/chi này đã huỷ trước đó');
      }
      entry.status = EntryStatus.VOIDED;
      entry.voidedAt = new Date();
      entry.voidedById = actor.id;
      entry.voidedByName = actor.name;
      entry.voidReason = dto.reason;
      await entries.save(entry);
      const from = contract.status;
      if (entry.costId) {
        const costs = manager.getRepository(OtherCashflowCost);
        const cost = await costs.findOneOrFail({ where: { id: entry.costId } });
        cost.paidAmount -= entry.amount;
        await costs.save(cost);
        contract.paidCostAmount -= entry.amount;
      } else {
        contract.recordedAmount -= entry.amount;
      }
      // Phiếu của lần bị huỷ quay về "chờ" — thủ quỹ thu/chi lại, hoặc KT công nợ huỷ phiếu.
      if (entry.orderId) {
        await manager
          .getRepository(OtherCashflowOrder)
          .update(entry.orderId, { status: OrderStatus.PENDING });
      }
      contract.status = statusForProgress(contract);
      await manager.getRepository(OtherCashflowContract).save(contract);
      await this.log(manager, id, actor, 'ENTRY_VOIDED', {
        from,
        to: contract.status,
        note: dto.reason,
        changes: {
          entryId,
          flow: entry.flow,
          amount: entry.amount,
          date: entry.entryDate,
          orderId: entry.orderId,
          costId: entry.costId,
        },
      });
    });
    return this.detail(user, id);
  }

  // ---------------------------------------------------------------------------
  // Hình thức Thương mại: kế toán công nợ lập phiếu → thủ quỹ thu/chi theo phiếu
  // ---------------------------------------------------------------------------

  async createOrder(user: AuthUser, id: number, dto: CreateOrderDto) {
    if (!canManageDebt(user)) {
      throw new ForbiddenException('Chỉ kế toán công nợ lập phiếu thu, lệnh chi');
    }
    const actor = await this.actor(user);
    const { contract, order, costLabel } = await this.dataSource.transaction(
      async (manager) => {
        const contract = await this.lock(manager, id);
        if (!canCreateOrder(user, contract)) {
          throw new BadRequestException(
            'Chỉ lập phiếu cho hợp đồng Thương mại đã duyệt và chưa hoàn tất',
          );
        }
        const orders = manager.getRepository(OtherCashflowOrder);
        const pending = await orders.find({
          where: { contractId: id, status: OrderStatus.PENDING },
        });
        let costLabel: string | null = null;
        if (dto.kind === OrderKind.RECEIPT) {
          const queued = sumMoney(
            pending.filter((o) => o.kind === OrderKind.RECEIPT).map((o) => o.amount),
          );
          const open = contract.amount - contract.recordedAmount - queued;
          if (dto.amount > open) {
            throw new BadRequestException(
              `Số tiền ${formatVnd(dto.amount)} đ vượt số còn phải thu chưa lập phiếu ${formatVnd(Math.max(0, open))} đ`,
            );
          }
        } else {
          // findOne với id undefined trả dòng bất kỳ — chặn trước.
          if (!dto.costId) {
            throw new BadRequestException('Vui lòng chọn khoản chi');
          }
          const cost = await manager
            .getRepository(OtherCashflowCost)
            .findOne({ where: { id: dto.costId, contractId: id } });
          if (!cost) {
            throw new BadRequestException('Khoản chi không thuộc hợp đồng này');
          }
          const queued = sumMoney(
            pending.filter((o) => o.costId === cost.id).map((o) => o.amount),
          );
          const open = cost.totalAmount - cost.paidAmount - queued;
          if (dto.amount > open) {
            throw new BadRequestException(
              `Số tiền ${formatVnd(dto.amount)} đ vượt khoản chi "${cost.description}" còn phải chi chưa lập lệnh ${formatVnd(Math.max(0, open))} đ`,
            );
          }
          costLabel = cost.description;
        }
        const order = await orders.save(
          orders.create({
            contractId: id,
            kind: dto.kind,
            costId: dto.kind === OrderKind.PAYMENT ? dto.costId! : null,
            amount: dto.amount,
            dueDate: dto.dueDate ?? null,
            note: dto.note || null,
            status: OrderStatus.PENDING,
            createdById: actor.id,
            createdByName: actor.name,
          }),
        );
        await this.log(manager, id, actor, 'ORDER_CREATED', {
          note: dto.note || null,
          changes: {
            orderId: order.id,
            kind: dto.kind,
            costId: order.costId,
            amount: dto.amount,
            dueDate: order.dueDate,
          },
        });
        return { contract, order, costLabel };
      },
    );
    await this.notify.orderCreated(contract, order, costLabel, actor);
    return this.detail(user, id);
  }

  async cancelOrder(
    user: AuthUser,
    id: number,
    orderId: number,
    dto: ReasonDto,
  ) {
    if (!canManageDebt(user)) {
      throw new ForbiddenException('Chỉ kế toán công nợ huỷ phiếu thu, lệnh chi');
    }
    const actor = await this.actor(user);
    await this.dataSource.transaction(async (manager) => {
      await this.lock(manager, id);
      const orders = manager.getRepository(OtherCashflowOrder);
      const order = await orders.findOne({ where: { id: orderId, contractId: id } });
      if (!order) throw new NotFoundException('Không tìm thấy phiếu');
      if (order.status !== OrderStatus.PENDING) {
        throw new ConflictException(
          'Chỉ huỷ được phiếu đang chờ — phiếu đã thu/chi thì thủ quỹ huỷ lần thu/chi trước',
        );
      }
      order.status = OrderStatus.CANCELLED;
      order.cancelledAt = new Date();
      order.cancelledByName = actor.name;
      order.cancelReason = dto.reason;
      await orders.save(order);
      await this.log(manager, id, actor, 'ORDER_CANCELLED', {
        note: dto.reason,
        changes: { orderId, kind: order.kind, amount: order.amount },
      });
    });
    return this.detail(user, id);
  }

  async executeOrder(
    user: AuthUser,
    id: number,
    orderId: number,
    dto: ExecuteOrderDto,
  ) {
    if (!canRecord(user)) {
      throw new ForbiddenException('Chỉ thủ quỹ thu/chi theo phiếu');
    }
    this.assertNotFuture(dto.date);
    const actor = await this.actor(user);
    const result = await this.dataSource.transaction(async (manager) => {
      const contract = await this.lock(manager, id);
      const existing = await this.replayed(manager, id, dto.idempotencyKey);
      if (existing) return { contract, entry: existing, order: null, replay: true };
      const orders = manager.getRepository(OtherCashflowOrder);
      const order = await orders.findOne({ where: { id: orderId, contractId: id } });
      if (!order) throw new NotFoundException('Không tìm thấy phiếu');
      if (order.status !== OrderStatus.PENDING) {
        throw new ConflictException('Phiếu đã được thu/chi hoặc đã huỷ — tải lại để xem');
      }
      if (!canExecuteOrder(user, contract)) {
        throw new BadRequestException('Hợp đồng không còn thu/chi được');
      }
      await this.assertCashAccount(manager, dto.cashAccountCode);
      const receipt = order.kind === OrderKind.RECEIPT;
      if (receipt) {
        if (contract.recordedAmount + order.amount > contract.amount) {
          throw new BadRequestException('Phiếu thu vượt số còn phải thu');
        }
        contract.recordedAmount += order.amount;
      } else {
        const costs = manager.getRepository(OtherCashflowCost);
        const cost = await costs.findOneOrFail({ where: { id: order.costId! } });
        if (cost.paidAmount + order.amount > cost.totalAmount) {
          throw new BadRequestException('Lệnh chi vượt khoản chi còn phải chi');
        }
        cost.paidAmount += order.amount;
        await costs.save(cost);
        contract.paidCostAmount += order.amount;
      }
      const entries = manager.getRepository(OtherCashflowEntry);
      const entry = await entries.save(
        entries.create({
          contractId: id,
          flow: receipt ? CashflowDirection.IN : CashflowDirection.OUT,
          orderId: order.id,
          costId: order.costId,
          entryDate: dto.date,
          amount: order.amount,
          cashAccountCode: dto.cashAccountCode,
          note: dto.note || null,
          idempotencyKey: dto.idempotencyKey,
          status: EntryStatus.RECORDED,
          recordedById: actor.id,
          recordedByName: actor.name,
        }),
      );
      order.status = OrderStatus.EXECUTED;
      await orders.save(order);
      const from = contract.status;
      contract.status = statusForProgress(contract);
      await manager.getRepository(OtherCashflowContract).save(contract);
      await this.log(manager, id, actor, 'ORDER_EXECUTED', {
        from,
        to: contract.status,
        note: dto.note || null,
        changes: {
          orderId: order.id,
          entryId: entry.id,
          kind: order.kind,
          date: dto.date,
          amount: order.amount,
          cashAccountCode: dto.cashAccountCode,
        },
      });
      return { contract, entry, order, replay: false };
    });
    if (!result.replay && result.order) {
      await this.notify.orderExecuted(result.contract, result.order, actor);
    }
    return result.entry;
  }

  // ---------------------------------------------------------------------------
  // Tệp
  // ---------------------------------------------------------------------------

  async uploadAttachments(
    user: AuthUser,
    id: number,
    files: Express.Multer.File[],
    dto: UploadAttachmentDto,
  ) {
    if (!files?.length) throw new BadRequestException('Chưa chọn tệp');
    if (files.length > ATTACHMENT_MAX_FILES_PER_UPLOAD) {
      throw new BadRequestException(
        `Tối đa ${ATTACHMENT_MAX_FILES_PER_UPLOAD} tệp mỗi lần`,
      );
    }
    for (const file of files) {
      const ext = extname(file.originalname || '').toLowerCase();
      if (!ATTACHMENT_EXTENSIONS.includes(ext)) {
        throw new BadRequestException(
          `"${decodeOriginalName(file.originalname)}": chỉ nhận PDF hoặc ảnh (${ATTACHMENT_EXTENSIONS.join(', ')})`,
        );
      }
    }
    const actor = await this.actor(user);
    const kind = dto.entryId
      ? OtherCashflowAttachmentKind.EVIDENCE
      : OtherCashflowAttachmentKind.CONTRACT;
    const storedPaths: string[] = [];
    try {
      await this.dataSource.transaction(async (manager) => {
        const contract = await this.lock(manager, id);
        if (kind === OtherCashflowAttachmentKind.CONTRACT) {
          if (!canUploadContractFile(user, contract)) {
            throw new ForbiddenException('Chỉ người lập bổ sung tệp hợp đồng');
          }
        } else {
          if (!canManageEvidence(user)) {
            throw new ForbiddenException('Chỉ thủ quỹ đính kèm chứng từ thu chi');
          }
          const entry = await manager
            .getRepository(OtherCashflowEntry)
            .findOne({ where: { id: dto.entryId!, contractId: id } });
          if (!entry || entry.status !== EntryStatus.RECORDED) {
            throw new BadRequestException(
              'Lần thu/chi không thuộc hợp đồng hoặc đã huỷ',
            );
          }
        }
        const repo = manager.getRepository(OtherCashflowAttachment);
        const active = await repo
          .createQueryBuilder('a')
          .where('a.contractId = :id AND a.deletedAt IS NULL', { id })
          .getCount();
        if (active + files.length > ATTACHMENT_MAX_FILES_PER_CONTRACT) {
          throw new BadRequestException(
            `Mỗi hợp đồng tối đa ${ATTACHMENT_MAX_FILES_PER_CONTRACT} tệp (đang có ${active})`,
          );
        }
        const names: string[] = [];
        for (const file of files) {
          const stored = await storeFile(file, `${STORAGE_FOLDER}/${id}`);
          storedPaths.push(stored.storagePath);
          await repo.save(
            repo.create({
              contractId: id,
              entryId: dto.entryId ?? null,
              kind,
              ...stored,
              uploadedById: actor.id,
              uploadedByName: actor.name,
            }),
          );
          names.push(stored.originalName);
        }
        await this.log(manager, id, actor, 'ATTACHMENT_ADDED', {
          changes: { kind, entryId: dto.entryId ?? null, files: names },
        });
      });
    } catch (error) {
      // Transaction không lưu → gỡ tệp đã ghi xuống đĩa.
      await Promise.all(
        storedPaths.map((path) => fs.unlink(absolutePath(path)).catch(() => undefined)),
      );
      throw error;
    }
    return this.detail(user, id);
  }

  async removeAttachment(user: AuthUser, id: number, attachmentId: number) {
    const actor = await this.actor(user);
    await this.dataSource.transaction(async (manager) => {
      const contract = await this.lock(manager, id);
      const repo = manager.getRepository(OtherCashflowAttachment);
      const attachment = await repo.findOne({
        where: { id: attachmentId, contractId: id },
      });
      if (!attachment || attachment.deletedAt) {
        throw new NotFoundException('Không tìm thấy tệp');
      }
      const allowed =
        attachment.kind === OtherCashflowAttachmentKind.CONTRACT
          ? canDeleteContractFile(user, contract)
          : canManageEvidence(user);
      if (!allowed) throw new ForbiddenException('Bạn không được xoá tệp này');
      attachment.deletedAt = new Date();
      await repo.save(attachment);
      await this.log(manager, id, actor, 'ATTACHMENT_REMOVED', {
        changes: { kind: attachment.kind, file: attachment.originalName },
      });
    });
    return this.detail(user, id);
  }

  async attachmentFile(user: AuthUser, id: number, attachmentId: number) {
    const contract = await this.contractRepo.findOne({ where: { id } });
    if (!contract || !canView(user, contract)) {
      throw new NotFoundException('Không tìm thấy hợp đồng thu chi ngoài');
    }
    const attachment = await this.attachmentRepo.findOne({
      where: { id: attachmentId, contractId: id },
    });
    if (!attachment || attachment.deletedAt) {
      throw new NotFoundException('Không tìm thấy tệp');
    }
    return { attachment, stream: openStoredFile(attachment.storagePath) };
  }

  // ---------------------------------------------------------------------------
  // Tiện ích
  // ---------------------------------------------------------------------------

  private async replaceLines(
    manager: EntityManager,
    contractId: number,
    lines: {
      items: Omit<OtherCashflowItem, 'id' | 'contractId' | 'contract'>[];
      costs: Omit<OtherCashflowCost, 'id' | 'contractId' | 'contract'>[];
    },
  ) {
    const items = manager.getRepository(OtherCashflowItem);
    const costs = manager.getRepository(OtherCashflowCost);
    await items.delete({ contractId });
    await costs.delete({ contractId });
    if (lines.items.length) {
      await items.save(lines.items.map((row) => items.create({ ...row, contractId })));
    }
    if (lines.costs.length) {
      await costs.save(lines.costs.map((row) => costs.create({ ...row, contractId })));
    }
  }

  private async itemDtos(
    manager: EntityManager,
    contractId: number,
  ): Promise<OtherCashflowItemDto[]> {
    const rows = await manager
      .getRepository(OtherCashflowItem)
      .find({ where: { contractId }, order: { lineNo: 'ASC' } });
    return rows.map((row) => ({
      itemCode: row.itemCode,
      itemName: row.itemName,
      unit: row.unit,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      vatRate: row.vatRate,
    }));
  }

  private async costDtos(
    manager: EntityManager,
    contractId: number,
  ): Promise<OtherCashflowCostDto[]> {
    const rows = await manager
      .getRepository(OtherCashflowCost)
      .find({ where: { contractId }, order: { lineNo: 'ASC' } });
    return rows.map((row) => ({
      itemCode: row.itemCode,
      description: row.description,
      payee: row.payee,
      unit: row.unit,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      vatRate: row.vatRate,
    }));
  }

  /** Bấm lặp / gửi lại cùng khoá → trả lần đã ghi, không ghi thêm. */
  private async replayed(
    manager: EntityManager,
    contractId: number,
    idempotencyKey: string,
  ) {
    const existing = await manager
      .getRepository(OtherCashflowEntry)
      .findOne({ where: { idempotencyKey } });
    if (existing && existing.contractId !== contractId) {
      throw new ConflictException('Khoá chống trùng đã dùng cho hợp đồng khác');
    }
    return existing;
  }

  private assertNotFuture(date: string) {
    if (date > vnToday()) {
      throw new BadRequestException('Ngày thu/chi không được sau hôm nay');
    }
  }

  private async actor(user: AuthUser): Promise<Actor> {
    const employee = await this.employeeRepo.findOne({
      where: { id: user.id },
      select: { id: true, name: true },
    });
    return { id: user.id, name: employee?.name ?? user.name ?? null };
  }

  private async lock(manager: EntityManager, id: number) {
    const contract = await manager
      .getRepository(OtherCashflowContract)
      .createQueryBuilder('c')
      .setLock('pessimistic_write')
      .where('c.id = :id', { id })
      .getOne();
    if (!contract) {
      throw new NotFoundException('Không tìm thấy hợp đồng thu chi ngoài');
    }
    return contract;
  }

  private async assertSchool(manager: EntityManager, schoolId?: number | null) {
    if (!schoolId) return;
    const exists = await manager
      .getRepository(School)
      .exists({ where: { id: schoolId } });
    if (!exists) throw new BadRequestException('Trường không tồn tại');
  }

  private async assertCashAccount(manager: EntityManager, code: string) {
    const account = await manager
      .getRepository(CashAccount)
      .findOne({ where: { code } });
    if (!account || !account.isActive) {
      throw new BadRequestException(`Tài khoản tiền "${code}" không hợp lệ`);
    }
  }

  private snapshot(contract: OtherCashflowContract) {
    return {
      form: contract.form,
      title: contract.title,
      documentNo: contract.documentNo,
      partnerName: contract.partnerName,
      schoolId: contract.schoolId,
      amount: contract.amount,
      incomeVatAmount: contract.incomeVatAmount,
      costAmount: contract.costAmount,
      costVatAmount: contract.costVatAmount,
      signedDate: contract.signedDate,
      expectedDate: contract.expectedDate,
      note: contract.note,
    };
  }

  private async log(
    manager: EntityManager,
    contractId: number,
    actor: Actor,
    action: string,
    extra: {
      from?: string | null;
      to?: string | null;
      note?: string | null;
      changes?: Record<string, unknown> | null;
    } = {},
  ) {
    const repo = manager.getRepository(OtherCashflowEvent);
    await repo.save(
      repo.create({
        contractId,
        action,
        fromStatus: extra.from ?? null,
        toStatus: extra.to ?? null,
        actorId: actor.id,
        actorName: actor.name,
        note: extra.note ?? null,
        changes: extra.changes ?? null,
      }),
    );
  }
}
