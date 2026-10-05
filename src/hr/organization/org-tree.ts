import type { OrgUnitStatus, OrgUnitType } from './org-policy';

/** Một đơn vị tại một ngày (revision có hiệu lực ngày đó). */
export interface OrgNode {
  id: number;
  code: string;
  revisionId: number;
  unitType: OrgUnitType;
  name: string;
  parentId: number | null;
  status: OrgUnitStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Giới hạn độ sâu — chặn vòng lặp nếu dữ liệu từng bị ghi sai. */
const MAX_DEPTH = 64;

/**
 * Cơ cấu tổ chức tại MỘT ngày. Mọi phép duyệt cây (tổ tiên, con cháu, chi
 * nhánh gần nhất, phát hiện vòng lặp) đều thuần, có chặn vòng lặp.
 */
export class OrgSnapshot {
  private readonly nodes = new Map<number, OrgNode>();
  private readonly childrenOf = new Map<number, number[]>();
  readonly asOf: string;

  constructor(asOf: string, nodes: OrgNode[]) {
    this.asOf = asOf;
    for (const n of nodes) this.nodes.set(n.id, n);
    this.reindex();
  }

  private reindex() {
    this.childrenOf.clear();
    for (const n of this.nodes.values()) {
      if (n.parentId === null) continue;
      const list = this.childrenOf.get(n.parentId) ?? [];
      list.push(n.id);
      this.childrenOf.set(n.parentId, list);
    }
  }

  /** Bản sao với một đơn vị được thay thuộc tính (mô phỏng revision mới). */
  withNode(node: OrgNode): OrgSnapshot {
    const next = new OrgSnapshot(this.asOf, [...this.nodes.values()]);
    next.nodes.set(node.id, node);
    next.reindex();
    return next;
  }

  get(id: number): OrgNode | undefined {
    return this.nodes.get(id);
  }

  all(): OrgNode[] {
    return [...this.nodes.values()];
  }

  children(id: number): OrgNode[] {
    return (this.childrenOf.get(id) ?? []).map((c) => this.nodes.get(c)!);
  }

  /** Tổ tiên từ cha lên gốc (không gồm chính nó). */
  ancestors(id: number): OrgNode[] {
    const out: OrgNode[] = [];
    const seen = new Set<number>([id]);
    let current = this.nodes.get(id)?.parentId ?? null;
    while (current !== null && out.length < MAX_DEPTH) {
      if (seen.has(current)) break;
      seen.add(current);
      const node = this.nodes.get(current);
      if (!node) break;
      out.push(node);
      current = node.parentId;
    }
    return out;
  }

  /** `id` nằm dưới `ancestorId` (không tính chính nó). */
  isStrictDescendant(id: number, ancestorId: number): boolean {
    return this.ancestors(id).some((a) => a.id === ancestorId);
  }

  /** Toàn bộ cây con, GỒM chính nó. */
  subtreeIds(id: number): Set<number> {
    const out = new Set<number>();
    const stack = [id];
    while (stack.length && out.size < 10_000) {
      const current = stack.pop()!;
      if (out.has(current)) continue;
      out.add(current);
      stack.push(...(this.childrenOf.get(current) ?? []));
    }
    return out;
  }

  /** Đơn vị gần nhất (gồm chính nó) thuộc một trong các loại. */
  nearest(id: number, types: readonly OrgUnitType[]): OrgNode | null {
    const self = this.nodes.get(id);
    if (!self) return null;
    if (types.includes(self.unitType)) return self;
    return this.ancestors(id).find((a) => types.includes(a.unitType)) ?? null;
  }

  /** Đặt `newParentId` làm cha của `unitId` có tạo vòng lặp không. */
  wouldCycle(unitId: number, newParentId: number | null): boolean {
    if (newParentId === null) return false;
    return this.subtreeIds(unitId).has(newParentId);
  }

  activeCompanies(exceptId?: number): OrgNode[] {
    return this.all().filter(
      (n) =>
        n.unitType === 'COMPANY' && n.status === 'ACTIVE' && n.id !== exceptId,
    );
  }
}
