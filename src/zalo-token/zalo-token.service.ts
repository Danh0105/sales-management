import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import qs from 'qs';
import { EntityManager, Repository } from 'typeorm';
import { ZaloToken } from './zalo-token.entity';

/** Refresh sớm khi access token còn dưới chừng này. */
const EXPIRY_MARGIN_MS = 60_000;
const OAUTH_URL = 'https://oauth.zaloapp.com/v4/oa/access_token';
/**
 * Khoá refresh dùng chung mọi process (3010 + 3011 cùng DB): refresh token của
 * Zalo chỉ dùng được một lần — hai process cùng refresh thì một bên làm hỏng
 * chuỗi token của bên kia.
 */
const REFRESH_LOCK_KEY = 'zalo_tokens:refresh';

/**
 * Lỗi đã làm sạch: chỉ mã/HTTP status — KHÔNG mang theo `config` của axios (chứa
 * `refresh_token`, `secret_key`) hay body response (có thể chứa token).
 */
export class ZaloTokenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ZaloTokenError';
    }
}

/**
 * Token OA giáo viên (`zalo_tokens`).
 *
 * KHÔNG BAO GIỜ log token hay body OAuth: token từng bị `console.log(res.data)`
 * ghi ra log pm2 mỗi lần refresh (sự cố 09/10/2026).
 */
@Injectable()
export class ZaloTokenService {
    private readonly logger = new Logger(ZaloTokenService.name);

    constructor(
        @InjectRepository(ZaloToken)
        private repo: Repository<ZaloToken>,
    ) { }

    async getValidToken(): Promise<string> {
        const token = await this.latest(this.repo.manager);
        if (token && isFresh(token)) return token.access_token;
        return this.refreshLocked();
    }

    /**
     * Refresh trong một transaction giữ advisory lock: process nào vào sau thì đọc
     * lại và dùng luôn token process trước vừa lấy, không gọi Zalo lần nữa.
     */
    private async refreshLocked(): Promise<string> {
        return this.repo.manager.transaction(async (em) => {
            await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
                REFRESH_LOCK_KEY,
            ]);
            const token = await this.latest(em);
            if (token && isFresh(token)) return token.access_token;
            if (!token?.refresh_token) {
                throw new ZaloTokenError(
                    'Không có refresh_token để lấy access_token',
                );
            }

            let data: Record<string, unknown> | undefined;
            try {
                const res = await axios.post<Record<string, unknown>>(
                    OAUTH_URL,
                    qs.stringify({
                        app_id: process.env.ZALO_APP_ID,
                        grant_type: 'refresh_token',
                        refresh_token: token.refresh_token,
                    }),
                    {
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            secret_key: process.env.ZALO_APP_SECRET,
                        },
                        timeout: 15_000,
                    },
                );
                data = res.data;
            } catch (error) {
                throw new ZaloTokenError(
                    `Refresh token Zalo OA thất bại (${describeHttpError(error)})`,
                );
            }

            const accessToken = data?.access_token;
            const refreshToken = data?.refresh_token;
            const expiresIn = Number(data?.expires_in);
            if (
                typeof accessToken !== 'string' ||
                !accessToken ||
                typeof refreshToken !== 'string' ||
                !refreshToken ||
                !Number.isFinite(expiresIn) ||
                expiresIn <= 0
            ) {
                // Chỉ mã lỗi Zalo — không log/không ném body (có thể chứa token).
                throw new ZaloTokenError(
                    `Zalo OA không trả token hợp lệ (${describeZaloError(data)})`,
                );
            }

            token.access_token = accessToken;
            token.refresh_token = refreshToken;
            token.expires_in = expiresIn;
            token.expires_at = Date.now() + expiresIn * 1000;
            await em.save(token);

            this.logger.log(
                `Đã refresh token Zalo OA (hết hạn ${new Date(token.expires_at).toISOString()})`,
            );
            return accessToken;
        });
    }

    // 👉 lưu lần đầu (manual)
    async saveInitialToken(data: {
        access_token: string;
        refresh_token: string;
        expires_in: number;
    }) {
        const now = Date.now();

        const token = this.repo.create({
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_in: data.expires_in,
            expires_at: now + data.expires_in * 1000,
        });

        return this.repo.save(token);
    }

    private latest(em: EntityManager): Promise<ZaloToken | null> {
        return em.getRepository(ZaloToken).findOne({
            where: {},
            order: { id: 'DESC' },
        });
    }
}

function isFresh(token: ZaloToken): boolean {
    return Number(token.expires_at) - Date.now() > EXPIRY_MARGIN_MS;
}

/** `HTTP 400` / `ECONNRESET`… — không bao giờ kèm config/body. */
export function describeHttpError(error: unknown): string {
    const e = error as {
        response?: { status?: number; data?: unknown };
        code?: unknown;
    };
    if (e?.response?.status) {
        return `HTTP ${e.response.status}${describeZaloError(e.response.data, ' ')}`;
    }
    return typeof e?.code === 'string' ? e.code : 'network';
}

/** Mã lỗi trong body Zalo (`error`, `error_name`) — bỏ mọi trường khác. */
export function describeZaloError(data: unknown, prefix = ''): string {
    if (!data || typeof data !== 'object') return prefix ? '' : 'không có body';
    const d = data as Record<string, unknown>;
    const parts = [d.error, d.error_name]
        .filter((v) => typeof v === 'string' || typeof v === 'number')
        .map(String)
        .map((v) => v.slice(0, 60));
    return parts.length ? `${prefix}${parts.join(' ')}` : prefix ? '' : 'không rõ mã';
}
