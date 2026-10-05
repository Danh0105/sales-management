import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { isScopeUnitAllowed, ScopeOptionType } from './org-scope-options';
import { OrgStructureRepository } from './org-structure.repository';

/**
 * Kiểm tra (chỉ đọc) `scopeRefId` của một quyền có phải đơn vị dùng được làm
 * phạm vi tại `asOf` không: tồn tại, có revision hiệu lực, ACTIVE, đúng loại
 * (BRANCH → chi nhánh; ORG_UNIT → phòng ban/nhóm). Cùng luật với ô chọn
 * `scope-options` (`isScopeUnitAllowed`) — một nguồn sự thật.
 *
 * Chỉ trả đúng/sai: nơi gọi báo một lỗi chung, không phân biệt lý do (tránh
 * thành công cụ dò cơ cấu).
 */
@Injectable()
export class OrgScopeUnitValidator {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly repo: OrgStructureRepository,
  ) {}

  async isValid(
    scopeType: ScopeOptionType,
    scopeRefId: number,
    asOf: string,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(scopeRefId) || scopeRefId < 1) return false;
    const node = await this.repo.nodeAt(
      this.dataSource.manager,
      scopeRefId,
      asOf,
    );
    return isScopeUnitAllowed(node, scopeType);
  }
}
