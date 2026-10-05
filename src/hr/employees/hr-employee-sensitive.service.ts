import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  EntityTarget,
  ObjectLiteral,
  QueryFailedError,
} from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { HrPermission } from '../access/hr-permission';
import { HrAuditAction } from '../audit/hr-audit-action';
import { HrAuditActor } from '../audit/hr-audit-actor';
import { HrAuditService } from '../audit/hr-audit.service';
import { HrBlindIndexService } from '../crypto/hr-blind-index.service';
import {
  blindIndexContext,
  employeeFieldContext,
  HrEncryptedField,
} from '../crypto/hr-crypto-context';
import { HrCryptoError } from '../crypto/hr-crypto.errors';
import { HrCryptoService } from '../crypto/hr-crypto.service';
import { HrEncryptionService } from '../crypto/hr-encryption.service';
import {
  CreateBankAccountDto,
  UpdateBankAccountDto,
} from './dto/bank-account.dto';
import {
  CreateIdentityDocumentDto,
  UpdateIdentityDocumentDto,
} from './dto/identity-document.dto';
import { HrEmployeeBankAccount } from './entities/hr-employee-bank-account.entity';
import { HrEmployeeIdentityDocument } from './entities/hr-employee-identity-document.entity';
import { HrEmployeeInsuranceProfile } from './entities/hr-employee-insurance-profile.entity';
import { HrEmployeeTaxProfile } from './entities/hr-employee-tax-profile.entity';
import { HrEmployee } from './entities/hr-employee.entity';
import { HrEmployeeService } from './hr-employee.service';
import {
  HrIdentifierKind,
  maskedFromLast4,
  PreparedIdentifier,
  prepareIdentifier,
} from './hr-sensitive-identifiers';

type WriteCrypto = {
  encryption: HrEncryptionService;
  blindIndex: HrBlindIndexService;
};

/** Giá trị đã chuẩn hoá + blind index; mã hoá làm SAU bước kiểm tra trùng. */
interface Protected {
  prepared: PreparedIdentifier;
  hash: string;
  candidates: string[];
}

/** Hồ sơ một-số (MST, BHXH): cùng một luồng, khác bảng/cột/audit. */
interface NumberProfileSpec {
  entity: EntityTarget<ObjectLiteral>;
  kind: Extract<HrIdentifierKind, 'TAX_NUMBER' | 'SOCIAL_INSURANCE_NUMBER'>;
  input: string;
  encrypted: string;
  last4: string;
  hash: string;
  hashColumn: string;
  masked: string;
  changed: string;
  auditEntity: string;
  created: HrAuditAction;
  updated: HrAuditAction;
}

const TAX: NumberProfileSpec = {
  entity: HrEmployeeTaxProfile,
  kind: 'TAX_NUMBER',
  input: 'taxNumber',
  encrypted: 'taxNumberEncrypted',
  last4: 'taxNumberLast4',
  hash: 'taxNumberHash',
  hashColumn: 'tax_number_hash',
  masked: 'taxNumberMasked',
  changed: 'taxNumberChanged',
  auditEntity: 'employee_tax_profile',
  created: HrAuditAction.TAX_PROFILE_CREATE,
  updated: HrAuditAction.TAX_PROFILE_UPDATE,
};

const INSURANCE: NumberProfileSpec = {
  entity: HrEmployeeInsuranceProfile,
  kind: 'SOCIAL_INSURANCE_NUMBER',
  input: 'socialInsuranceNumber',
  encrypted: 'socialInsuranceNumberEncrypted',
  last4: 'socialInsuranceNumberLast4',
  hash: 'socialInsuranceNumberHash',
  hashColumn: 'social_insurance_number_hash',
  masked: 'socialInsuranceNumberMasked',
  changed: 'socialInsuranceNumberChanged',
  auditEntity: 'employee_insurance_profile',
  created: HrAuditAction.INSURANCE_PROFILE_CREATE,
  updated: HrAuditAction.INSURANCE_PROFILE_UPDATE,
};

const DUPLICATE_CONSTRAINTS = [
  'UQ_hr_identity_documents_hash',
  'UQ_hr_bank_accounts_number',
  'UQ_hr_tax_profiles_hash',
  'UQ_hr_insurance_profiles_hash',
];

function duplicate() {
  // Không nêu hồ sơ nào đang giữ số này — người gọi có thể không có quyền xem hồ sơ đó.
  return new ConflictException({
    statusCode: 409,
    code: 'HR_IDENTIFIER_DUPLICATE',
    message: 'Số định danh này đã được dùng cho một hồ sơ khác',
  });
}

function alreadyExists() {
  return new ConflictException({
    statusCode: 409,
    code: 'HR_RECORD_EXISTS',
    message: 'Hồ sơ đã có bản ghi này — dùng cập nhật thay vì tạo mới',
  });
}

function versionConflict() {
  return new ConflictException({
    statusCode: 409,
    code: 'HR_VERSION_CONFLICT',
    message: 'Dữ liệu đã bị người khác thay đổi — tải lại rồi thử lại',
  });
}

function assertPeriod(issuedOn?: string | null, expiresOn?: string | null) {
  if (issuedOn && expiresOn && expiresOn < issuedOn) {
    throw new BadRequestException('expiresOn phải sau hoặc bằng issuedOn');
  }
}

export function identityView(d: HrEmployeeIdentityDocument) {
  return {
    id: d.id,
    employeeId: d.employeeId,
    documentType: d.documentType,
    numberMasked: maskedFromLast4(d.numberLast4),
    issuedOn: d.issuedOn,
    expiresOn: d.expiresOn,
    issuedPlace: d.issuedPlace,
    version: d.version,
    updatedAt: d.updatedAt,
  };
}

export function bankView(b: HrEmployeeBankAccount) {
  return {
    id: b.id,
    employeeId: b.employeeId,
    bankCode: b.bankCode,
    bankName: b.bankName,
    branchName: b.branchName,
    accountHolderName: b.accountHolderName,
    accountNumberMasked: maskedFromLast4(b.accountNumberLast4),
    version: b.version,
    updatedAt: b.updatedAt,
  };
}

function profileView(spec: NumberProfileSpec, row: ObjectLiteral) {
  return {
    id: row.id as number,
    employeeId: row.employeeId as number,
    [spec.masked]: maskedFromLast4(row[spec.last4] as string),
    version: row.version as number,
    updatedAt: row.updatedAt as Date,
  };
}

/**
 * CCCD / hộ chiếu / GPLĐ, tài khoản ngân hàng, MST, BHXH.
 *
 * Ghi:  quyền + phạm vi → crypto sẵn sàng (503) → chuẩn hoá + kiểm tra định
 *       dạng → blind index → (transaction) kiểm tra trùng → mã hoá với context
 *       gắn nhân viên → ghi encrypted + last4 + hash → audit dạng che.
 * Đọc:  chỉ dạng che từ `last4`, không giải mã.
 * Reveal: quyền riêng + phạm vi → giải mã → audit (có lý do) → trả giá trị.
 *
 * Không bao giờ fallback plaintext; lỗi crypto → không ghi gì.
 */
@Injectable()
export class HrEmployeeSensitiveService {
  private readonly logger = new Logger(HrEmployeeSensitiveService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly employees: HrEmployeeService,
    private readonly crypto: HrCryptoService,
    private readonly audit: HrAuditService,
  ) {}

  // ─── CCCD / CMND / hộ chiếu / giấy phép lao động ───────────────────────

  async listIdentityDocuments(actorId: number, employeeId: number) {
    await this.employees.loadAuthorized(
      actorId,
      employeeId,
      HrPermission.EMPLOYEE_VIEW,
    );
    const rows = await this.dataSource
      .getRepository(HrEmployeeIdentityDocument)
      .find({ where: { employeeId }, order: { id: 'ASC' } });
    return rows.map(identityView);
  }

  async createIdentityDocument(
    actorId: number,
    actor: HrAuditActor,
    employeeId: number,
    dto: CreateIdentityDocumentDto,
  ) {
    const employee = await this.employees.loadAuthorized(
      actorId,
      employeeId,
      HrPermission.EMPLOYEE_EDIT,
    );
    const crypto = this.crypto.forSensitiveWrite();
    assertPeriod(dto.issuedOn, dto.expiresOn);
    const value = this.protect(
      crypto,
      prepareIdentifier(dto.documentType, dto.number, 'number'),
    );

    return this.write(async (manager) => {
      await this.assertUnique(
        manager,
        HrEmployeeIdentityDocument,
        'number_hash',
        value.candidates,
      );
      const exists = await manager.exists(HrEmployeeIdentityDocument, {
        where: { employeeId, documentType: dto.documentType },
      });
      if (exists) throw alreadyExists();

      const id = await this.insert(manager, HrEmployeeIdentityDocument, {
        employeeId,
        documentType: dto.documentType,
        numberEncrypted: this.encrypt(crypto, employee, value),
        numberLast4: value.prepared.last4,
        numberHash: value.hash,
        issuedOn: dto.issuedOn ?? null,
        expiresOn: dto.expiresOn ?? null,
        issuedPlace: dto.issuedPlace ?? null,
        version: 1,
        createdBy: actorId,
        updatedBy: actorId,
      });
      const row = await manager.findOneByOrFail(HrEmployeeIdentityDocument, {
        id,
      });
      await this.audit.record(manager, {
        actor,
        action: HrAuditAction.IDENTITY_CREATE,
        entity: 'employee_identity_document',
        entityId: id,
        newValue: {
          employeeId,
          documentType: row.documentType,
          numberMasked: maskedFromLast4(row.numberLast4),
          issuedOn: row.issuedOn,
          expiresOn: row.expiresOn,
          issuedPlace: row.issuedPlace,
        },
      });
      return identityView(row);
    });
  }

  async updateIdentityDocument(
    actorId: number,
    actor: HrAuditActor,
    employeeId: number,
    documentId: number,
    dto: UpdateIdentityDocumentDto,
  ) {
    const employee = await this.employees.loadAuthorized(
      actorId,
      employeeId,
      HrPermission.EMPLOYEE_EDIT,
    );
    const crypto = this.crypto.forSensitiveWrite();
    const current = await this.findOwned(
      HrEmployeeIdentityDocument,
      documentId,
      employeeId,
    );
    const value =
      dto.number === undefined
        ? null
        : this.protect(
            crypto,
            prepareIdentifier(current.documentType, dto.number, 'number'),
          );

    return this.write(async (manager) => {
      const old = await this.lockForUpdate(
        manager,
        HrEmployeeIdentityDocument,
        documentId,
        dto.version,
      );
      const issuedOn = dto.issuedOn === undefined ? old.issuedOn : dto.issuedOn;
      const expiresOn =
        dto.expiresOn === undefined ? old.expiresOn : dto.expiresOn;
      assertPeriod(issuedOn, expiresOn);

      const patch: Partial<HrEmployeeIdentityDocument> = {
        issuedOn,
        expiresOn,
        issuedPlace:
          dto.issuedPlace === undefined ? old.issuedPlace : dto.issuedPlace,
        updatedBy: actorId,
      };
      if (value) {
        await this.assertUnique(
          manager,
          HrEmployeeIdentityDocument,
          'number_hash',
          value.candidates,
          { excludeId: documentId },
        );
        patch.numberEncrypted = this.encrypt(crypto, employee, value);
        patch.numberLast4 = value.prepared.last4;
        patch.numberHash = value.hash;
      }
      await this.updateVersioned(
        manager,
        HrEmployeeIdentityDocument,
        documentId,
        dto.version,
        patch,
      );
      const row = await manager.findOneByOrFail(HrEmployeeIdentityDocument, {
        id: documentId,
      });
      await this.audit.record(manager, {
        actor,
        action: HrAuditAction.IDENTITY_UPDATE,
        entity: 'employee_identity_document',
        entityId: documentId,
        oldValue: {
          employeeId,
          documentType: old.documentType,
          numberMasked: maskedFromLast4(old.numberLast4),
          issuedOn: old.issuedOn,
          expiresOn: old.expiresOn,
          issuedPlace: old.issuedPlace,
          version: old.version,
        },
        newValue: {
          employeeId,
          documentType: row.documentType,
          numberMasked: maskedFromLast4(row.numberLast4),
          numberChanged: this.changed(value, old.numberHash),
          issuedOn: row.issuedOn,
          expiresOn: row.expiresOn,
          issuedPlace: row.issuedPlace,
          version: row.version,
        },
      });
      return identityView(row);
    });
  }

  async revealIdentityDocument(
    actorId: number,
    actor: HrAuditActor,
    employeeId: number,
    documentId: number,
    reason: string,
  ) {
    const employee = await this.employees.loadAuthorized(
      actorId,
      employeeId,
      HrPermission.IDENTITY_REVEAL,
    );
    const doc = await this.findOwned(
      HrEmployeeIdentityDocument,
      documentId,
      employeeId,
    );
    const number = this.decrypt(
      doc.numberEncrypted,
      employee,
      HrEncryptedField.IDENTITY_NUMBER,
      `employee_identity_document#${doc.id}`,
    );
    // Audit TRƯỚC khi trả: ghi audit lỗi → không trả giá trị.
    await this.audit.recordStandalone({
      actor,
      action: HrAuditAction.IDENTITY_REVEAL,
      entity: 'employee_identity_document',
      entityId: doc.id,
      newValue: { employeeId, documentType: doc.documentType, field: 'number' },
      reason,
    });
    return {
      id: doc.id,
      employeeId,
      documentType: doc.documentType,
      number,
    };
  }

  // ─── Tài khoản ngân hàng ───────────────────────────────────────────────

  async getBankAccount(actorId: number, employeeId: number) {
    await this.employees.loadAuthorized(
      actorId,
      employeeId,
      HrPermission.EMPLOYEE_VIEW,
    );
    return bankView(await this.findBankAccount(employeeId));
  }

  async createBankAccount(
    actorId: number,
    actor: HrAuditActor,
    employeeId: number,
    dto: CreateBankAccountDto,
  ) {
    const employee = await this.employees.loadAuthorized(
      actorId,
      employeeId,
      HrPermission.EMPLOYEE_EDIT,
    );
    const crypto = this.crypto.forSensitiveWrite();
    const value = this.protect(
      crypto,
      prepareIdentifier('BANK_ACCOUNT', dto.accountNumber, 'accountNumber'),
    );

    return this.write(async (manager) => {
      if (
        await manager.exists(HrEmployeeBankAccount, { where: { employeeId } })
      )
        throw alreadyExists();
      await this.assertUnique(
        manager,
        HrEmployeeBankAccount,
        'account_number_hash',
        value.candidates,
        { bankCode: dto.bankCode },
      );
      const id = await this.insert(manager, HrEmployeeBankAccount, {
        employeeId,
        bankCode: dto.bankCode,
        bankName: dto.bankName,
        branchName: dto.branchName ?? null,
        accountHolderName: dto.accountHolderName,
        accountNumberEncrypted: this.encrypt(crypto, employee, value),
        accountNumberLast4: value.prepared.last4,
        accountNumberHash: value.hash,
        version: 1,
        createdBy: actorId,
        updatedBy: actorId,
      });
      const row = await manager.findOneByOrFail(HrEmployeeBankAccount, { id });
      await this.audit.record(manager, {
        actor,
        action: HrAuditAction.BANK_ACCOUNT_CREATE,
        entity: 'employee_bank_account',
        entityId: id,
        newValue: this.bankAudit(row),
      });
      return bankView(row);
    });
  }

  async updateBankAccount(
    actorId: number,
    actor: HrAuditActor,
    employeeId: number,
    dto: UpdateBankAccountDto,
  ) {
    const employee = await this.employees.loadAuthorized(
      actorId,
      employeeId,
      HrPermission.EMPLOYEE_EDIT,
    );
    const crypto = this.crypto.forSensitiveWrite();
    const current = await this.findBankAccount(employeeId);
    const value =
      dto.accountNumber === undefined
        ? null
        : this.protect(
            crypto,
            prepareIdentifier(
              'BANK_ACCOUNT',
              dto.accountNumber,
              'accountNumber',
            ),
          );

    return this.write(async (manager) => {
      const old = await this.lockForUpdate(
        manager,
        HrEmployeeBankAccount,
        current.id,
        dto.version,
      );
      const bankCode = dto.bankCode ?? old.bankCode;
      const patch: Partial<HrEmployeeBankAccount> = {
        bankCode,
        bankName: dto.bankName ?? old.bankName,
        branchName:
          dto.branchName === undefined ? old.branchName : dto.branchName,
        accountHolderName: dto.accountHolderName ?? old.accountHolderName,
        updatedBy: actorId,
      };
      if (value || bankCode !== old.bankCode) {
        await this.assertUnique(
          manager,
          HrEmployeeBankAccount,
          'account_number_hash',
          value ? value.candidates : [old.accountNumberHash],
          { bankCode, excludeId: old.id },
        );
      }
      if (value) {
        patch.accountNumberEncrypted = this.encrypt(crypto, employee, value);
        patch.accountNumberLast4 = value.prepared.last4;
        patch.accountNumberHash = value.hash;
      }
      await this.updateVersioned(
        manager,
        HrEmployeeBankAccount,
        old.id,
        dto.version,
        patch,
      );
      const row = await manager.findOneByOrFail(HrEmployeeBankAccount, {
        id: old.id,
      });
      await this.audit.record(manager, {
        actor,
        action: HrAuditAction.BANK_ACCOUNT_UPDATE,
        entity: 'employee_bank_account',
        entityId: old.id,
        oldValue: { ...this.bankAudit(old), version: old.version },
        newValue: {
          ...this.bankAudit(row),
          accountNumberChanged: this.changed(value, old.accountNumberHash),
          version: row.version,
        },
      });
      return bankView(row);
    });
  }

  async revealBankAccount(
    actorId: number,
    actor: HrAuditActor,
    employeeId: number,
    reason: string,
  ) {
    const employee = await this.employees.loadAuthorized(
      actorId,
      employeeId,
      HrPermission.BANK_REVEAL,
    );
    const account = await this.findBankAccount(employeeId);
    const accountNumber = this.decrypt(
      account.accountNumberEncrypted,
      employee,
      HrEncryptedField.BANK_ACCOUNT_NUMBER,
      `employee_bank_account#${account.id}`,
    );
    await this.audit.recordStandalone({
      actor,
      action: HrAuditAction.BANK_REVEAL,
      entity: 'employee_bank_account',
      entityId: account.id,
      newValue: {
        employeeId,
        bankCode: account.bankCode,
        field: 'accountNumber',
      },
      reason,
    });
    return {
      id: account.id,
      employeeId,
      bankCode: account.bankCode,
      accountNumber,
    };
  }

  // ─── MST / BHXH (chỉ dạng che; chưa có quyền reveal riêng) ─────────────

  getTaxProfile(actorId: number, employeeId: number) {
    return this.getProfile(TAX, actorId, employeeId);
  }

  saveTaxProfile(
    actorId: number,
    actor: HrAuditActor,
    employeeId: number,
    number: string,
    version?: number,
  ) {
    return this.saveProfile(TAX, actorId, actor, employeeId, number, version);
  }

  getInsuranceProfile(actorId: number, employeeId: number) {
    return this.getProfile(INSURANCE, actorId, employeeId);
  }

  saveInsuranceProfile(
    actorId: number,
    actor: HrAuditActor,
    employeeId: number,
    number: string,
    version?: number,
  ) {
    return this.saveProfile(
      INSURANCE,
      actorId,
      actor,
      employeeId,
      number,
      version,
    );
  }

  private async getProfile(
    spec: NumberProfileSpec,
    actorId: number,
    employeeId: number,
  ) {
    await this.employees.loadAuthorized(
      actorId,
      employeeId,
      HrPermission.EMPLOYEE_VIEW,
    );
    const row = await this.dataSource
      .getRepository(spec.entity)
      .findOne({ where: { employeeId } });
    if (!row) throw new NotFoundException('Chưa có dữ liệu');
    return profileView(spec, row);
  }

  /** `version` undefined = tạo mới; có `version` = cập nhật (optimistic lock). */
  private async saveProfile(
    spec: NumberProfileSpec,
    actorId: number,
    actor: HrAuditActor,
    employeeId: number,
    number: string,
    version?: number,
  ) {
    const employee = await this.employees.loadAuthorized(
      actorId,
      employeeId,
      HrPermission.EMPLOYEE_EDIT,
    );
    const crypto = this.crypto.forSensitiveWrite();
    const value = this.protect(
      crypto,
      prepareIdentifier(spec.kind, number, spec.input),
    );
    const current =
      version === undefined
        ? null
        : await this.dataSource
            .getRepository(spec.entity)
            .findOne({ where: { employeeId } });
    if (version !== undefined && !current) {
      throw new NotFoundException('Chưa có dữ liệu');
    }

    return this.write(async (manager) => {
      const old = current
        ? await this.lockForUpdate(
            manager,
            spec.entity,
            current.id as number,
            version!,
          )
        : null;
      if (
        !old &&
        (await manager.exists(spec.entity, { where: { employeeId } }))
      )
        throw alreadyExists();
      await this.assertUnique(
        manager,
        spec.entity,
        spec.hashColumn,
        value.candidates,
        {
          excludeId: old?.id as number | undefined,
        },
      );

      const secret = {
        [spec.encrypted]: this.encrypt(crypto, employee, value),
        [spec.last4]: value.prepared.last4,
        [spec.hash]: value.hash,
      };
      let id: number;
      if (old) {
        id = old.id as number;
        await this.updateVersioned(manager, spec.entity, id, version!, {
          ...secret,
          updatedBy: actorId,
        });
      } else {
        id = await this.insert(manager, spec.entity, {
          employeeId,
          ...secret,
          version: 1,
          createdBy: actorId,
          updatedBy: actorId,
        });
      }
      const row = await manager.findOneByOrFail(spec.entity, { id });
      await this.audit.record(manager, {
        actor,
        action: old ? spec.updated : spec.created,
        entity: spec.auditEntity,
        entityId: id,
        oldValue: old
          ? {
              employeeId,
              [spec.masked]: maskedFromLast4(old[spec.last4] as string),
              version: old.version as number,
            }
          : undefined,
        newValue: {
          employeeId,
          [spec.masked]: maskedFromLast4(row[spec.last4] as string),
          ...(old
            ? { [spec.changed]: this.changed(value, old[spec.hash] as string) }
            : {}),
          version: row.version as number,
        },
      });
      return profileView(spec, row);
    });
  }

  // ─── Dùng chung ────────────────────────────────────────────────────────

  private protect(
    crypto: WriteCrypto,
    prepared: PreparedIdentifier,
  ): Protected {
    const context = blindIndexContext(prepared.domain);
    return {
      prepared,
      hash: crypto.blindIndex.hash(prepared.value, context),
      candidates: crypto.blindIndex.candidates(prepared.value, context),
    };
  }

  private encrypt(
    crypto: WriteCrypto,
    employee: HrEmployee,
    value: Protected,
  ): string {
    return crypto.encryption.encrypt(
      value.prepared.value,
      employeeFieldContext(employee.id, value.prepared.field),
    );
  }

  /** Giải mã cho reveal. Lỗi → 500 không kèm dữ liệu; không trả ciphertext. */
  private decrypt(
    payload: string,
    employee: HrEmployee,
    field: HrEncryptedField,
    ref: string,
  ): string {
    const encryption = this.crypto.encryption();
    try {
      return encryption.decrypt(
        payload,
        employeeFieldContext(employee.id, field),
      );
    } catch (error) {
      const code = error instanceof HrCryptoError ? error.code : 'UNKNOWN';
      this.logger.error(`Giải mã thất bại (${code}) tại ${ref}`);
      throw new InternalServerErrorException({
        statusCode: 500,
        code: 'HR_DECRYPTION_FAILED',
        message: 'Không đọc được dữ liệu đã mã hoá',
      });
    }
  }

  /** Số mới có khác số cũ không — so blind index (mọi version), không giải mã. */
  private changed(value: Protected | null, oldHash: string): boolean {
    return value !== null && !value.candidates.includes(oldHash);
  }

  private bankAudit(b: HrEmployeeBankAccount) {
    return {
      employeeId: b.employeeId,
      bankCode: b.bankCode,
      bankName: b.bankName,
      branchName: b.branchName,
      accountHolderName: b.accountHolderName,
      accountNumberMasked: maskedFromLast4(b.accountNumberLast4),
    };
  }

  private async findBankAccount(employeeId: number) {
    const row = await this.dataSource
      .getRepository(HrEmployeeBankAccount)
      .findOne({ where: { employeeId } });
    if (!row) throw new NotFoundException('Chưa có dữ liệu');
    return row;
  }

  private async findOwned<T extends ObjectLiteral>(
    entity: EntityTarget<T>,
    id: number,
    employeeId: number,
  ): Promise<T> {
    const row = await this.dataSource
      .getRepository(entity)
      .findOne({ where: { id, employeeId } as never });
    if (!row) throw new NotFoundException('Không tìm thấy dữ liệu');
    return row;
  }

  private async assertUnique(
    manager: EntityManager,
    entity: EntityTarget<ObjectLiteral>,
    hashColumn: string,
    candidates: string[],
    options: { excludeId?: number; bankCode?: string } = {},
  ) {
    const qb = manager
      .getRepository(entity)
      .createQueryBuilder('r')
      .where(`r.${hashColumn} IN (:...candidates)`, { candidates });
    if (options.excludeId !== undefined) {
      qb.andWhere('r.id <> :excludeId', { excludeId: options.excludeId });
    }
    if (options.bankCode !== undefined) {
      qb.andWhere('r.bank_code = :bankCode', { bankCode: options.bankCode });
    }
    if (await qb.getExists()) throw duplicate();
  }

  private async lockForUpdate<T extends ObjectLiteral>(
    manager: EntityManager,
    entity: EntityTarget<T>,
    id: number,
    version: number,
  ): Promise<T> {
    const row = await manager
      .getRepository(entity)
      .createQueryBuilder('r')
      .setLock('pessimistic_write')
      .where('r.id = :id', { id })
      .getOne();
    if (!row) throw new NotFoundException('Không tìm thấy dữ liệu');
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async updateVersioned<T extends ObjectLiteral>(
    manager: EntityManager,
    entity: EntityTarget<T>,
    id: number,
    version: number,
    patch: Record<string, unknown>,
  ) {
    const result = await manager
      .createQueryBuilder()
      .update(entity)
      .set({
        ...patch,
        version: () => '"version" + 1',
        updatedAt: () => 'now()',
      } as QueryDeepPartialEntity<T>)
      .where('id = :id AND version = :version', { id, version })
      .execute();
    if (!result.affected) throw versionConflict();
  }

  private async insert<T extends ObjectLiteral>(
    manager: EntityManager,
    entity: EntityTarget<T>,
    values: Record<string, unknown>,
  ): Promise<number> {
    const result = await manager.insert(
      entity,
      values as QueryDeepPartialEntity<T>,
    );
    return (result.identifiers[0] as { id: number }).id;
  }

  /** Transaction; unique violation (đua nhau ghi) → 409 tương ứng. */
  private async write<T>(fn: (manager: EntityManager) => Promise<T>) {
    try {
      return await this.dataSource.transaction(fn);
    } catch (error) {
      if (error instanceof QueryFailedError) {
        const driver = error.driverError as {
          code?: string;
          constraint?: string;
        };
        if (driver?.code === '23505') {
          throw DUPLICATE_CONSTRAINTS.includes(driver.constraint ?? '')
            ? duplicate()
            : alreadyExists();
        }
      }
      throw error;
    }
  }
}
