import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

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
  /** Latch bền được bật khi emergency mutation không thể commit cùng audit. */
  failsafeHalted: boolean;
  failsafeReason: string | null;
  failsafeAt: Date | null;
  /** Không đọc được DB hoặc latch fail-safe đang bật → mọi phạm vi dừng. */
  failClosed: boolean;
}

interface RuntimeRow {
  ai_halted: boolean;
  worker_halted: boolean;
  outbound_halted: boolean;
  reason: string | null;
  updated_by: number | null;
  updated_at: Date;
  failsafe_halted: boolean;
  failsafe_reason: string | null;
  failsafe_at: Date | null;
}

type StopListener = (scopes: ReadonlySet<RuntimeControlScope>) => void;
type AutoHaltCallback = (
  em: EntityManager,
  state: RuntimeControlState,
) => Promise<unknown>;

/** Cột tương ứng từng phạm vi — tên cột cố định, không lấy từ input. */
const COLUMN: Record<RuntimeControlScope, string> = {
  [RuntimeControlScope.AI]: 'ai_halted',
  [RuntimeControlScope.WORKER]: 'worker_halted',
  [RuntimeControlScope.OUTBOUND]: 'outbound_halted',
};

const ALL_SCOPES = new Set<RuntimeControlScope>([
  RuntimeControlScope.AI,
  RuntimeControlScope.WORKER,
  RuntimeControlScope.OUTBOUND,
]);

const FAIL_CLOSED: RuntimeControlState = Object.freeze({
  aiHalted: true,
  workerHalted: true,
  outboundHalted: true,
  reason: 'RUNTIME_CONTROLS_UNREADABLE',
  updatedBy: null,
  updatedAt: null,
  failsafeHalted: true,
  failsafeReason: 'RUNTIME_CONTROLS_UNREADABLE',
  failsafeAt: null,
  failClosed: true,
});

const SELECT_ROW = `SELECT ai_halted, worker_halted, outbound_halted, reason, updated_by, updated_at,
                            failsafe_halted, failsafe_reason, failsafe_at
                     FROM "recruitment_runtime_controls" WHERE id = 1`;

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
 * Runtime stop với hai lớp fail-closed:
 *
 * 1. State mutation + mandatory Recruitment audit dùng cùng transaction và khóa dòng id=1.
 * 2. Nếu emergency STOP/AUTO-HALT rollback (audit hoặc DB lỗi), bật latch fail-safe riêng
 *    best-effort trong DB để mọi process dừng. Nếu DB hoàn toàn không dùng được, singleton
 *    hiện tại vẫn latch trong RAM; mọi read lỗi cũng trả FAIL_CLOSED.
 *
 * `failsafe_halted` không giả làm một operator mutation và không sinh audit giả. Nó chỉ được
 * xóa bởi RESUME đủ cả ba scope, trong transaction có mandatory audit thành công.
 */
@Injectable()
export class RecruitmentRuntimeControlService {
  private readonly logger = new Logger('RecruitmentRuntimeControl');
  private cached: { at: number; state: RuntimeControlState } | null = null;
  private lastFailClosed = false;
  /**
   * Latch RAM khi một lệnh dừng khẩn / tự dừng không commit được. `persisted`: latch đã
   * nằm trong DB (ghi được hoặc đã thấy `failsafe_halted`) — khi đó DB mất latch nghĩa là
   * đã có RESUME đủ 3 phạm vi có audit (đường duy nhất gỡ latch) ⇒ bỏ latch RAM.
   */
  private localFailsafe: {
    reason: string;
    at: Date;
    persisted: boolean;
  } | null = null;
  private readonly stopListeners = new Set<StopListener>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: RecruitmentAuditService,
  ) {}

  onStop(listener: StopListener): () => void {
    this.stopListeners.add(listener);
    return () => this.stopListeners.delete(listener);
  }

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
      const [row]: RuntimeRow[] = await this.dataSource.query(SELECT_ROW);
      if (!row) {
        state = FAIL_CLOSED;
      } else {
        await this.reconcileLocalFailsafe(row);
        state = this.fromRow(row);
      }
    } catch {
      // Đọc lỗi / thiếu dòng: dừng mọi phạm vi CHỪNG NÀO còn lỗi (claim, giữ chỗ, dispatch
      // cũng cần DB). Không bật latch bền: lỗi đọc thoáng qua không phải là lệnh dừng.
      state = FAIL_CLOSED;
    }
    if (state.failClosed !== this.lastFailClosed) {
      this.lastFailClosed = state.failClosed;
      if (state.failClosed) {
        this.logger.error(
          'runtime controls fail-closed — DỪNG AI / worker / outbound',
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
    try {
      const result = await this.dataSource.transaction(async (em) => {
        const [row]: RuntimeRow[] = await em.query(`${SELECT_ROW} FOR UPDATE`);
        if (!row) this.missing();

        const resumeAll =
          !halted &&
          unique.length === ALL_SCOPES.size &&
          unique.every((scope) => ALL_SCOPES.has(scope));
        if (
          !halted &&
          (row.failsafe_halted || this.localFailsafe) &&
          !resumeAll
        ) {
          throw new ServiceUnavailableException({
            code: 'RUNTIME_FAILSAFE_RESUME_ALL_REQUIRED',
            message:
              'Fail-safe đang bật; phải mở lại đồng thời AI, WORKER và OUTBOUND',
          });
        }

        const before = this.fromRow(row, false);
        const flagsChanged = unique.some(
          (scope) => row[COLUMN[scope] as keyof RuntimeRow] !== halted,
        );
        const clearsFailsafe =
          resumeAll && Boolean(row.failsafe_halted || this.localFailsafe);
        if (!flagsChanged && !clearsFailsafe) {
          return { state: this.fromRow(row), changed: false };
        }

        const [afterRow] = returnedRows<RuntimeRow>(
          await em.query(
            `UPDATE "recruitment_runtime_controls"
           SET ${unique.map((scope) => `"${COLUMN[scope]}" = $1`).join(', ')},
               reason = $2, updated_by = $3, updated_at = now(),
               failsafe_halted = CASE WHEN $4::boolean THEN false ELSE failsafe_halted END,
               failsafe_reason = CASE WHEN $4::boolean THEN NULL ELSE failsafe_reason END,
               failsafe_at = CASE WHEN $4::boolean THEN NULL ELSE failsafe_at END
           WHERE id = 1
           RETURNING ai_halted, worker_halted, outbound_halted, reason, updated_by, updated_at,
                     failsafe_halted, failsafe_reason, failsafe_at`,
            [halted, reason, actor.employeeId ?? null, clearsFailsafe],
          ),
        );
        if (!afterRow) this.missing();
        const after = this.fromRow(afterRow, false);
        await this.audit.recordMandatory(em, {
          actor,
          action: halted ? 'RUNTIME_STOP' : 'RUNTIME_RESUME',
          entity: 'runtime-controls',
          entityId: 1,
          before: snapshot(before),
          after: snapshot(after),
          context: {
            scopes: unique,
            reason,
            before: flags(before),
            after: flags(after),
            failsafeCleared: clearsFailsafe,
          },
        });
        return { state: this.fromRow(afterRow), changed: true };
      });

      this.cached = null;
      if (!halted && result.changed) this.localFailsafe = null;
      if (halted && result.changed) this.notifyStop(new Set(unique));
      this.logger.warn(
        `runtime ${halted ? 'STOP' : 'RESUME'} scopes=${unique.join(',')} actor=${actor.type}:${actor.employeeId ?? '-'}${result.changed ? '' : ' idempotent=true'}`,
      );
      return result.state;
    } catch (error) {
      if (halted) await this.engageFailsafe('RUNTIME_STOP_TRANSACTION_FAILED');
      throw error;
    }
  }

  /**
   * Auto-halt: khóa cùng dòng với quota reservation và operator stop. Worker đầu tiên
   * đổi false→true ghi mandatory audit (và callback alert nếu có) trong cùng transaction;
   * các worker sau nhận null, không audit/alert trùng.
   */
  async haltAiIfRunning(
    reason: string,
    actor: RecruitmentActor,
    alsoInTx?: AutoHaltCallback,
  ): Promise<RuntimeControlState | null> {
    try {
      const state = await this.dataSource.transaction(async (em) => {
        const [row]: RuntimeRow[] = await em.query(`${SELECT_ROW} FOR UPDATE`);
        if (!row) this.missing();
        if (row.ai_halted || row.failsafe_halted) return null;
        const before = this.fromRow(row, false);
        const [afterRow] = returnedRows<RuntimeRow>(
          await em.query(
            `UPDATE "recruitment_runtime_controls"
           SET ai_halted = true, reason = $1, updated_by = $2, updated_at = now()
           WHERE id = 1
           RETURNING ai_halted, worker_halted, outbound_halted, reason, updated_by, updated_at,
                     failsafe_halted, failsafe_reason, failsafe_at`,
            [reason, actor.employeeId ?? null],
          ),
        );
        if (!afterRow) this.missing();
        const after = this.fromRow(afterRow, false);
        await this.audit.recordMandatory(em, {
          actor,
          action: 'RUNTIME_STOP',
          entity: 'runtime-controls',
          entityId: 1,
          before: snapshot(before),
          after: snapshot(after),
          context: {
            scopes: [RuntimeControlScope.AI],
            reason,
            before: flags(before),
            after: flags(after),
          },
        });
        await alsoInTx?.(em, after);
        return after;
      });
      this.cached = null;
      if (state) {
        this.notifyStop(new Set([RuntimeControlScope.AI]));
        this.logger.warn(
          `runtime STOP scopes=${RuntimeControlScope.AI} actor=${actor.type}:${actor.employeeId ?? '-'}`,
        );
      }
      return state;
    } catch (error) {
      await this.engageFailsafe('AUTO_HALT_TRANSACTION_FAILED');
      throw error;
    }
  }

  private async engageFailsafe(reason: string): Promise<void> {
    const latch = { reason, at: new Date(), persisted: false };
    this.localFailsafe = latch;
    this.cached = null;
    this.notifyStop(new Set(ALL_SCOPES));
    latch.persisted = await this.persistFailsafe(reason);
    this.logger.error(
      `runtime FAILSAFE scopes=AI,WORKER,OUTBOUND reason=${reason} persisted=${latch.persisted}`,
    );
  }

  /**
   * Đồng bộ latch RAM với DB sau mỗi lần đọc được dòng điều khiển: DB đang latch ⇒ đã lưu;
   * latch từng lưu mà DB không còn ⇒ đã có RESUME đủ 3 phạm vi có audit (có thể ở process
   * khác) ⇒ bỏ latch RAM; chưa từng lưu được ⇒ thử lưu lại.
   */
  private async reconcileLocalFailsafe(row: RuntimeRow): Promise<void> {
    const latch = this.localFailsafe;
    if (!latch) return;
    if (row.failsafe_halted) {
      latch.persisted = true;
      return;
    }
    if (latch.persisted) {
      this.localFailsafe = null;
      this.logger.warn(
        `runtime FAILSAFE đã được gỡ bằng RESUME có audit — bỏ latch RAM (${latch.reason})`,
      );
      return;
    }
    latch.persisted = await this.persistFailsafe(latch.reason);
  }

  /** `true` khi latch đã nằm trong DB (ghi mới hoặc đã có sẵn). */
  private async persistFailsafe(reason: string): Promise<boolean> {
    try {
      const rows = returnedRows(
        await this.dataSource.query(
          `UPDATE "recruitment_runtime_controls"
           SET failsafe_halted = true,
               failsafe_reason = CASE WHEN failsafe_halted THEN failsafe_reason ELSE $1 END,
               failsafe_at = coalesce(failsafe_at, clock_timestamp())
           WHERE id = 1 RETURNING id`,
          [reason],
        ),
      );
      return rows.length > 0;
    } catch {
      // DB không ghi được: latch RAM + state() fail-closed vẫn chặn process này.
      return false;
    }
  }

  private notifyStop(scopes: ReadonlySet<RuntimeControlScope>): void {
    for (const listener of this.stopListeners) {
      try {
        listener(scopes);
      } catch {
        // Listener chỉ là fast local abort; DB state vẫn là nguồn sự thật.
      }
    }
  }

  private fromRow(row: RuntimeRow, includeLocal = true): RuntimeControlState {
    const local = includeLocal ? this.localFailsafe : null;
    const failClosed = row.failsafe_halted || Boolean(local);
    return {
      aiHalted: row.ai_halted || failClosed,
      workerHalted: row.worker_halted || failClosed,
      outboundHalted: row.outbound_halted || failClosed,
      reason: local?.reason ?? row.failsafe_reason ?? row.reason,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
      failsafeHalted: failClosed,
      failsafeReason: local?.reason ?? row.failsafe_reason,
      failsafeAt: local?.at ?? row.failsafe_at,
      failClosed,
    };
  }

  private missing(): never {
    throw new ServiceUnavailableException({
      code: 'RUNTIME_CONTROLS_MISSING',
      message: 'Thiếu dòng recruitment_runtime_controls',
    });
  }
}

function flags(state: RuntimeControlState) {
  return {
    ai: state.aiHalted,
    worker: state.workerHalted,
    outbound: state.outboundHalted,
  };
}

function snapshot(state: RuntimeControlState) {
  return {
    ...flags(state),
    reason: state.reason,
    updatedBy: state.updatedBy,
    updatedAt: state.updatedAt,
    failsafeHalted: state.failsafeHalted,
    failsafeReason: state.failsafeReason,
    failsafeAt: state.failsafeAt,
  };
}
