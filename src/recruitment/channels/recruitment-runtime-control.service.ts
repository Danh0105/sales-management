import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { RecruitmentAuditService } from '../recruitment-audit.service';
import { RuntimeControlScope } from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';
import { returnedRows } from './recruitment-channel-event.queue';

export interface RuntimeControlState {
  aiHalted: boolean;
  workerHalted: boolean;
  outboundHalted: boolean;
  reason: string | null;
  updatedBy: number | null;
  updatedAt: Date | null;
  /** Không đọc được bảng → mọi phạm vi coi như đang dừng. */
  failClosed: boolean;
}

/** Cột tương ứng từng phạm vi — tên cột cố định, không lấy từ input. */
const COLUMN: Record<RuntimeControlScope, string> = {
  [RuntimeControlScope.AI]: 'ai_halted',
  [RuntimeControlScope.WORKER]: 'worker_halted',
  [RuntimeControlScope.OUTBOUND]: 'outbound_halted',
};

const FAIL_CLOSED: RuntimeControlState = Object.freeze({
  aiHalted: true,
  workerHalted: true,
  outboundHalted: true,
  reason: 'RUNTIME_CONTROLS_UNREADABLE',
  updatedBy: null,
  updatedAt: null,
  failClosed: true,
});

export function isHalted(
  state: RuntimeControlState,
  scope: RuntimeControlScope,
): boolean {
  switch (scope) {
    case RuntimeControlScope.AI:
      return state.aiHalted;
    case RuntimeControlScope.WORKER:
      return state.workerHalted;
    case RuntimeControlScope.OUTBOUND:
      return state.outboundHalted;
  }
}

/**
 * Dừng khẩn AI / worker / outbound KHÔNG cần restart (P3-7.3 / G8). Đọc dòng duy nhất của
 * `recruitment_runtime_controls`: worker và sender đọc mới mỗi vòng lặp (hiệu lực trong ~1
 * chu kỳ poll), guard API AI dùng bản đọc ≤ 1 giây. Không đọc được bảng → coi như dừng tất
 * cả (fail-closed). Đổi trạng thái chỉ qua `set` — luôn ghi audit (người vận hành hoặc
 * hệ thống khi vượt trần).
 */
@Injectable()
export class RecruitmentRuntimeControlService {
  private readonly logger = new Logger('RecruitmentRuntimeControl');
  private cached: { at: number; state: RuntimeControlState } | null = null;
  private lastFailClosed = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: RecruitmentAuditService,
  ) {}

  /** `maxAgeMs` > 0: dùng bản đọc gần đây nếu còn mới (guard API AI); 0: luôn đọc mới. */
  async state(maxAgeMs = 0): Promise<RuntimeControlState> {
    if (
      maxAgeMs > 0 &&
      this.cached &&
      Date.now() - this.cached.at <= maxAgeMs
    ) {
      return this.cached.state;
    }
    let state: RuntimeControlState;
    try {
      const [row]: Array<{
        ai_halted: boolean;
        worker_halted: boolean;
        outbound_halted: boolean;
        reason: string | null;
        updated_by: number | null;
        updated_at: Date;
      }> = await this.dataSource.query(
        `SELECT ai_halted, worker_halted, outbound_halted, reason, updated_by, updated_at
         FROM "recruitment_runtime_controls" WHERE id = 1`,
      );
      state = row
        ? {
            aiHalted: row.ai_halted,
            workerHalted: row.worker_halted,
            outboundHalted: row.outbound_halted,
            reason: row.reason,
            updatedBy: row.updated_by,
            updatedAt: row.updated_at,
            failClosed: false,
          }
        : FAIL_CLOSED;
    } catch {
      state = FAIL_CLOSED;
    }
    if (state.failClosed !== this.lastFailClosed) {
      this.lastFailClosed = state.failClosed;
      if (state.failClosed) {
        this.logger.error(
          'runtime controls không đọc được — coi như DỪNG AI / worker / outbound',
        );
      } else {
        this.logger.warn('runtime controls đọc lại được');
      }
    }
    this.cached = { at: Date.now(), state };
    return state;
  }

  async set(
    scopes: RuntimeControlScope[],
    halted: boolean,
    reason: string,
    actor: RecruitmentActor,
  ): Promise<RuntimeControlState> {
    const unique = [...new Set(scopes)];
    const before = await this.state();
    const rows = returnedRows(
      await this.dataSource.query(
        `UPDATE "recruitment_runtime_controls"
         SET ${unique.map((s) => `"${COLUMN[s]}" = $1`).join(', ')},
             reason = $2, updated_by = $3, updated_at = now()
         WHERE id = 1 RETURNING id`,
        [halted, reason, actor.employeeId],
      ),
    );
    if (!rows.length) {
      throw new ServiceUnavailableException({
        code: 'RUNTIME_CONTROLS_MISSING',
        message: 'Thiếu dòng recruitment_runtime_controls',
      });
    }
    this.cached = null;
    const after = await this.state();
    await this.audit.record({
      actor,
      action: halted ? 'RUNTIME_STOP' : 'RUNTIME_RESUME',
      entity: 'runtime-controls',
      entityId: 1,
      context: {
        scopes: unique,
        reason,
        before: flags(before),
        after: flags(after),
      },
    });
    this.logger.warn(
      `runtime ${halted ? 'STOP' : 'RESUME'} scopes=${unique.join(',')} actor=${actor.type}:${actor.employeeId ?? '-'}`,
    );
    return after;
  }
}

function flags(state: RuntimeControlState) {
  return {
    ai: state.aiHalted,
    worker: state.workerHalted,
    outbound: state.outboundHalted,
  };
}
