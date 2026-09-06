/**
 * Đổi `code` OAuth (lấy từ Zalo OA console sau khi cấp quyền lại) sang cặp
 * access_token/refresh_token mới, rồi lưu vào bảng `zalo_tokens` — dùng khi
 * refresh_token cũ đã hỏng (`Invalid refresh token`, lỗi Zalo -14014) nên cơ
 * chế tự refresh trong `ZaloTokenService.getValidToken()` không tự phục hồi
 * được, phải cấp lại từ đầu bằng tay.
 *
 * Chạy: npm run zalo:exchange-token -- <code>
 *
 * Lấy `code`: vào Zalo OA console (app tương ứng ZALO_APP_ID trong .env) →
 * chạy lại luồng cấp quyền OAuth cho OA → Zalo redirect kèm `?code=...` trên
 * URL callback đã khai.
 */
import { Client } from 'pg';
import axios from 'axios';
import qs from 'qs';
import * as dotenv from 'dotenv';

dotenv.config();

const DB = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sales_db',
};

async function main() {
    const code = process.argv[2];
    if (!code) {
        console.error('Thiếu code. Chạy: npm run zalo:exchange-token -- <code>');
        process.exit(1);
    }

    const appId = process.env.ZALO_APP_ID;
    const appSecret = process.env.ZALO_APP_SECRET;
    if (!appId || !appSecret) {
        console.error('Thiếu ZALO_APP_ID / ZALO_APP_SECRET trong .env');
        process.exit(1);
    }

    console.log('Đang đổi code lấy access_token/refresh_token...');
    const res = await axios.post(
        'https://oauth.zaloapp.com/v4/oa/access_token',
        qs.stringify({
            app_id: appId,
            code,
            grant_type: 'authorization_code',
        }),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                secret_key: appSecret,
            },
        },
    );

    const { access_token, refresh_token, expires_in } = res.data || {};
    if (!access_token || !refresh_token) {
        console.error('Zalo không trả về token hợp lệ:', res.data);
        process.exit(1);
    }

    const expiresAt = Date.now() + Number(expires_in || 0) * 1000;

    const client = new Client(DB);
    await client.connect();
    try {
        await client.query(
            `INSERT INTO zalo_tokens (access_token, refresh_token, expires_in, expires_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, now(), now())`,
            [access_token, refresh_token, expires_in, expiresAt],
        );
        console.log('✅ Đã lưu token mới vào zalo_tokens. Hết hạn lúc:', new Date(expiresAt).toISOString());
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error('❌ Đổi token thất bại:', err?.response?.data || err.message || err);
    process.exit(1);
});
