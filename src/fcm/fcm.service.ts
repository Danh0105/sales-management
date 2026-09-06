import { Injectable }
    from '@nestjs/common';

import * as admin
    from 'firebase-admin';

import * as path
    from 'path';

import { EmployeeFcmTokenService } from '../employee-fcm-token/employee-fcm-token.service';


@Injectable()
export class FcmService {
    constructor(
        private readonly employeeFcmTokenService: EmployeeFcmTokenService,
    ) {
        if (!admin.apps.length) {
            const serviceAccount =
                require(
                    path.join(
                        process.cwd(),
                        '/src/config/kidoapp-1a672-firebase-adminsdk-fbsvc-078eef6c9c.json',
                    ),
                );

            admin.initializeApp({
                credential:
                    admin.credential.cert(
                        serviceAccount,
                    ),
            });
        }
    }
    async sendToDevice(
        token: string,
        title: string,
        body: string,
        data: Record<string, string> = {},
    ) {
        try {
            return await admin.messaging().send({
                token,
                notification: {
                    title,
                    body,
                },
                data,
                android: {
                    priority: 'high',
                    notification: {
                        sound: 'default',
                        channelId: 'default',
                    },
                },
                apns: {
                    payload: {
                        aps: {
                            sound: 'default',
                        },
                    },
                },
            });
        } catch (error: any) {
            const code = error?.code || error?.errorInfo?.code;

            if (
                code === 'messaging/registration-token-not-registered' ||
                code === 'messaging/invalid-registration-token' ||
                code === 'messaging/invalid-argument'
            ) {
                await this.employeeFcmTokenService.removeInvalidTokens([token]);
            }

            console.error('FCM send error:', error);
            throw error;
        }
    }

    async sendToMultiple(
        tokens: string[],
        title: string,
        body: string,
        data: Record<string, string> = {},
    ) {
        const uniqueTokens = [...new Set(tokens)].filter(Boolean);

        if (uniqueTokens.length === 0) {
            return;
        }

        const results = await Promise.allSettled(
            uniqueTokens.map((token) =>
                admin.messaging().send({
                    token,
                    notification: {
                        title,
                        body,
                    },
                    data,
                    android: {
                        priority: 'high',
                        notification: {
                            sound: 'default',
                            channelId: 'default',
                        },
                    },
                    apns: {
                        payload: {
                            aps: {
                                sound: 'default',
                            },
                        },
                    },
                }),
            ),
        );

        const invalidTokens: string[] = [];

        results.forEach((result, index) => {
            const token = uniqueTokens[index];

            if (result.status === 'rejected') {
                const error = result.reason;

                console.error('FCM Error:', error);

                const code = error?.code || error?.errorInfo?.code;

                if (
                    code === 'messaging/registration-token-not-registered' ||
                    code === 'messaging/invalid-registration-token' ||
                    code === 'messaging/invalid-argument'
                ) {
                    invalidTokens.push(token);
                }
            }
        });

        if (invalidTokens.length > 0) {
            await this.employeeFcmTokenService.removeInvalidTokens(invalidTokens);

            console.log('🗑 Deleted invalid FCM tokens:', invalidTokens.length);
        }
        return {
            total: uniqueTokens.length,
            success: results.filter((r) => r.status === 'fulfilled').length,
            failed: results.filter((r) => r.status === 'rejected').length,
            deleted: invalidTokens.length,
        };
    }
}