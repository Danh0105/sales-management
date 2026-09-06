import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import qs from 'qs';
import { ZaloToken } from './zalo-token.entity';

@Injectable()
export class ZaloTokenService {
    constructor(
        @InjectRepository(ZaloToken)
        private repo: Repository<ZaloToken>,
    ) { }

    async getValidToken(): Promise<string> {
        const token = await this.repo.findOne({
            where: {},
            order: { id: 'DESC' },
        });

        const now = Date.now();

        // ✅ nếu còn hạn
        if (token && token.expires_at > now) {
            return token.access_token;
        }

        // 🔄 refresh token
        if (token?.refresh_token) {
            const res = await axios.post(
                'https://oauth.zaloapp.com/v4/oa/access_token',
                qs.stringify({
                    app_id: process.env.ZALO_APP_ID,
                    grant_type: 'refresh_token',
                    refresh_token: token.refresh_token,

                }),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'secret_key': process.env.ZALO_APP_SECRET
                    },
                },
            );
            console.log(res.data)
            const { access_token, refresh_token, expires_in } = res.data;

            token.access_token = access_token;
            token.refresh_token = refresh_token;
            token.expires_in = expires_in;
            token.expires_at = now + expires_in * 1000;

            await this.repo.save(token);

            return access_token;
        }

        throw new Error('Không có refresh_token để lấy access_token');
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
}