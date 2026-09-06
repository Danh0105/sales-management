import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import express from 'express';
import { createHash } from 'crypto';
import request from 'supertest';

import { ZaloOaController } from './zalo-oa.controller';
import { ZaloOaService } from './zalo-oa.service';

/**
 * Kiểm tra tầng HTTP: chữ ký tính trên **body thô**, nên phải dựng app với đúng
 * cấu hình body-parser của main.ts — sai chỗ này là chữ ký luôn lệch trên thật
 * dù unit test của service vẫn xanh.
 */
describe('ZaloOaController', () => {
    let app: INestApplication;

    const APP_ID = 'app-1';
    const SECRET = 'secret-key';

    const handleEvent = jest
        .fn()
        .mockResolvedValue({ action: 'linked', employeeId: 7 });

    beforeAll(async () => {
        process.env.ZALO_OA_SECRET_KEY = SECRET;
        delete process.env.ZALO_OA_WEBHOOK_VERIFY;

        const moduleRef = await Test.createTestingModule({
            controllers: [ZaloOaController],
            providers: [
                {
                    provide: ZaloOaService,
                    useValue: {
                        handleEvent,
                        // Dùng bản thật để test đúng phần ghép chuỗi ký.
                        verifySignature: new ZaloOaService(
                            {} as any,
                            {} as any,
                        ).verifySignature.bind({
                            logger: { warn: jest.fn(), error: jest.fn() },
                        }),
                    },
                },
            ],
        }).compile();

        app = moduleRef.createNestApplication();
        app.use(
            express.json({
                verify: (req: any, _res, buf) => {
                    req.rawBody = buf;
                },
            }),
        );
        await app.init();
    });

    afterAll(async () => {
        await app.close();
        delete process.env.ZALO_OA_SECRET_KEY;
    });

    beforeEach(() => handleEvent.mockClear());

    const send = (payload: object, mac?: string) => {
        const raw = JSON.stringify(payload);
        const req = request(app.getHttpServer())
            .post('/zalo/oa/webhook')
            .set('Content-Type', 'application/json');

        if (mac !== undefined) req.set('X-ZEvent-Signature', `mac=${mac}`);

        return req.send(raw);
    };

    const macFor = (payload: object) => {
        const raw = JSON.stringify(payload);
        return createHash('sha256')
            .update(`${APP_ID}${raw}${(payload as any).timestamp ?? ''}${SECRET}`)
            .digest('hex');
    };

    it('chữ ký đúng thì xử lý sự kiện và trả 200', async () => {
        const payload = {
            app_id: APP_ID,
            timestamp: '1700000000',
            event_name: 'user_send_text',
            sender: { id: 'zalo-abc' },
            message: { text: '0901234508' },
        };

        const res = await send(payload, macFor(payload));

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, action: 'linked', employeeId: 7 });
        expect(handleEvent).toHaveBeenCalledWith(
            expect.objectContaining({ event_name: 'user_send_text' }),
        );
    });

    it('thiếu chữ ký thì chặn, không đụng tới xử lý sự kiện', async () => {
        const payload = { app_id: APP_ID, timestamp: '1', event_name: 'follow' };

        const res = await send(payload);

        expect(res.status).toBe(403);
        expect(handleEvent).not.toHaveBeenCalled();
    });

    it('chữ ký sai thì chặn', async () => {
        const payload = { app_id: APP_ID, timestamp: '1', event_name: 'follow' };

        const res = await send(payload, 'khong-dung');

        expect(res.status).toBe(403);
        expect(handleEvent).not.toHaveBeenCalled();
    });
});
