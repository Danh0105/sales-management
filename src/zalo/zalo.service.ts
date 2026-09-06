import { Injectable, UnauthorizedException } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class ZaloService {
    async getZaloUser(accessToken: string) {
        try {
            const res = await axios.get(
                'https://graph.zalo.me/v2.0/me',
                {
                    params: {
                        access_token: accessToken,
                        fields: 'id,name,picture',
                    },
                    timeout: 5000,
                },
            );

            const data = res.data;

            if (data.error) {
                throw new UnauthorizedException(data.message || 'Zalo error');
            }

            return {
                id: data.id,
                name: data.name,
                avatar: data.picture?.data?.url || null,
            };
        } catch (error) {
            console.error('Zalo verify error:', error?.response?.data || error.message);
            throw new UnauthorizedException('Zalo token không hợp lệ');
        }
    }
}