import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import type { Request, Response } from 'express';
import { from, Observable, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { Repository } from 'typeorm';

import { RecruitmentAiIdempotencyKey } from '../entities/recruitment-ai-idempotency-key.entity';
import { IdempotencyStatus } from '../recruitment.enums';
import { isUniqueViolation } from '../recruitment.views';

const IDEMPOTENCY_REQUIRED = 'recruitment:idempotency-required';

/** Endpoint có side effect khó gỡ (giữ chỗ slot...) — bắt buộc gửi `Idempotency-Key`. */
export const RequireIdempotencyKey = () =>
  SetMetadata(IDEMPOTENCY_REQUIRED, true);

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,255}$/;
/** Key cũ hơn thế này coi như hết hạn — retry sau 1 ngày là một yêu cầu mới. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** JSON với khoá đã sắp xếp — cùng nội dung khác thứ tự khoá vẫn ra cùng hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function hashRequest(params: unknown, body: unknown): string {
  return createHash('sha256')
    .update(stableStringify({ params: params ?? {}, body: body ?? null }))
    .digest('hex');
}

/**
 * `Idempotency-Key` cho các POST của API AI:
 * - lần đầu: chạy handler, lưu response;
 * - retry cùng key + cùng nội dung: trả lại đúng response cũ (header
 *   `Idempotent-Replayed: true`), handler không chạy lại;
 * - cùng key nhưng khác nội dung: 422;
 * - request trước còn đang chạy: 409, caller đợi rồi thử lại.
 *
 * Handler lỗi thì xoá key để retry chạy lại được (thao tác lỗi không để lại
 * tác dụng vì service chạy trong transaction).
 */
@Injectable()
export class RecruitmentAiIdempotencyInterceptor implements NestInterceptor {
  constructor(
    @InjectRepository(RecruitmentAiIdempotencyKey)
    private readonly repo: Repository<RecruitmentAiIdempotencyKey>,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    if (req.method !== 'POST' && req.method !== 'PATCH') return next.handle();

    const required = this.reflector.getAllAndOverride<boolean>(
      IDEMPOTENCY_REQUIRED,
      [context.getHandler(), context.getClass()],
    );
    const raw: unknown = req.headers?.[IDEMPOTENCY_HEADER];
    if (raw === undefined || raw === '') {
      if (required) {
        throw new BadRequestException({
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Endpoint này bắt buộc header Idempotency-Key',
        });
      }
      return next.handle();
    }
    if (typeof raw !== 'string' || !KEY_PATTERN.test(raw)) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key gồm 8–255 ký tự chữ, số, ".", "_", ":", "-"',
      });
    }

    const routePath: unknown = (req.route as { path?: unknown } | undefined)
      ?.path;
    const endpoint =
      `${req.method} ${typeof routePath === 'string' ? routePath : req.path}`.slice(
        0,
        150,
      );
    const requestHash = hashRequest(req.params, req.body);
    const where = { idempotencyKey: raw, endpoint };
    const res = http.getResponse<Response>();

    const existing = await this.repo.findOne({ where });
    if (existing) {
      if (
        Date.now() - new Date(existing.createdAt).getTime() <
        IDEMPOTENCY_TTL_MS
      ) {
        return this.replay(existing, requestHash, res);
      }
      await this.repo.delete({ id: existing.id });
    }

    let record: RecruitmentAiIdempotencyKey;
    try {
      record = await this.repo.save(
        this.repo.create({
          idempotencyKey: raw,
          endpoint,
          requestHash,
          status: IdempotencyStatus.IN_PROGRESS,
          responseBody: null,
        }),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.repo.findOne({ where });
      if (!raced) throw error;
      return this.replay(raced, requestHash, res);
    }

    return (next.handle() as Observable<unknown>).pipe(
      mergeMap((body) =>
        from(
          this.repo.update(
            { id: record.id },
            {
              status: IdempotencyStatus.COMPLETED,
              responseBody: (body ?? null) as never,
            },
          ),
        ).pipe(mergeMap(() => of(body))),
      ),
      catchError((err: unknown) =>
        from(this.repo.delete({ id: record.id }).catch(() => undefined)).pipe(
          mergeMap(() => throwError(() => err)),
        ),
      ),
    );
  }

  private replay(
    record: RecruitmentAiIdempotencyKey,
    requestHash: string,
    res: Pick<Response, 'setHeader'>,
  ): Observable<unknown> {
    if (record.requestHash !== requestHash) {
      throw new UnprocessableEntityException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency-Key đã dùng cho một request có nội dung khác',
      });
    }
    if (record.status !== IdempotencyStatus.COMPLETED) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message: 'Request cùng Idempotency-Key đang được xử lý — thử lại sau',
      });
    }
    res.setHeader('Idempotent-Replayed', 'true');
    return of(record.responseBody);
  }
}
